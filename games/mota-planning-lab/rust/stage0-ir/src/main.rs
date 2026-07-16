use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Instant;

const RULE_VERSION: &str = "stage0-subset-v2";
const MAX_SEARCH_NODES: usize = 16_384;
const MIN_SAMPLE_NS: u128 = 100_000_000;
const CALIBRATION_TARGET_NS: u128 = 250_000_000;
const PERF_SAMPLES: usize = 3;
const MAX_REPETITIONS: usize = 10_000_000;
const RESULT_SCHEMA_VERSION: u64 = 4;
const CHECKSUM_SEED: u64 = 0xcbf29ce484222325;

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
struct State {
    hp: i64,
    attack: i64,
    defense: i64,
    gold: i64,
    yellow: i64,
}

#[derive(Clone, Debug, Deserialize)]
struct Action {
    id: String,
    floor: u32,
    requires: Vec<String>,
    #[serde(default)]
    hp: i64,
    #[serde(default)]
    attack: i64,
    #[serde(default)]
    defense: i64,
    #[serde(default)]
    gold: i64,
    #[serde(default)]
    yellow: i64,
    #[serde(default)]
    consume_yellow: i64,
    #[serde(default)]
    terminal: bool,
    #[serde(default)]
    choice_group: Option<String>,
    #[serde(default)]
    requires_choice: Option<String>,
}
#[derive(Debug, Deserialize)]
struct Metadata {
    rule_version: String,
}
#[derive(Debug, Deserialize)]
struct Fixture {
    metadata: Metadata,
    initial: State,
    actions: Vec<Action>,
}
#[derive(Clone)]
struct CompactAction {
    floor: u32,
    requires: Vec<usize>,
    delta: [i64; 5],
    terminal: bool,
    choice_group: Option<String>,
    requires_choice: Option<String>,
}
#[derive(Clone)]
struct SearchNode {
    state: State,
    done: Vec<u64>,
    depth: usize,
}

fn apply_raw(state: State, row: &Action) -> Option<State> {
    let next = State {
        hp: state.hp + row.hp,
        attack: state.attack + row.attack,
        defense: state.defense + row.defense,
        gold: state.gold + row.gold,
        yellow: state.yellow + row.yellow - row.consume_yellow,
    };
    (next.hp > 0 && next.yellow >= 0).then_some(next)
}
fn apply_compact(state: State, row: &CompactAction) -> Option<State> {
    let next = State {
        hp: state.hp + row.delta[0],
        attack: state.attack + row.delta[1],
        defense: state.defense + row.delta[2],
        gold: state.gold + row.delta[3],
        yellow: state.yellow + row.delta[4],
    };
    (next.hp > 0 && next.yellow >= 0).then_some(next)
}
fn score(state: State) -> i64 {
    state.hp * 1_000_000 + (state.attack + state.defense) * 1_000 + state.defense
}

fn dominates(left: State, right: State) -> bool {
    let pairs = [
        (left.hp, right.hp),
        (left.attack, right.attack),
        (left.defense, right.defense),
        (left.gold, right.gold),
        (left.yellow, right.yellow),
    ];
    pairs.iter().all(|(a, b)| a >= b) && pairs.iter().any(|(a, b)| a > b)
}

#[inline(never)]
fn state_checksum(mut checksum: u64, state: State, ordinal: usize) -> u64 {
    checksum ^= (ordinal as u64 + 1).wrapping_mul(0x9e3779b185ebca87);
    for field in [
        state.hp,
        state.attack,
        state.defense,
        state.gold,
        state.yellow,
    ] {
        checksum ^= field as u64;
        checksum = checksum.wrapping_mul(0x100000001b3);
    }
    checksum
}

fn search_checksum(result: &Value) -> Result<u64, String> {
    let mut value = CHECKSUM_SEED;
    for key in [
        "nodes",
        "node_limit",
        "candidate_transitions",
        "pareto_labels",
        "pruned",
    ] {
        value ^= result[key]
            .as_u64()
            .ok_or_else(|| format!("missing {key}"))?;
        value = value.wrapping_mul(0x100000001b3);
    }
    value ^= u64::from(
        result["node_limit_reached"]
            .as_bool()
            .ok_or("missing node_limit_reached")?,
    );
    value = value.wrapping_mul(0x100000001b3);
    value ^= result["logical_allocation_events"]
        .as_u64()
        .ok_or("missing logical_allocation_events")?;
    Ok(value.wrapping_mul(0x100000001b3))
}

fn load(path: &Path) -> Result<(Fixture, String), String> {
    let raw = fs::read(path).map_err(|e| e.to_string())?;
    let mut value: Value = serde_json::from_slice(&raw).map_err(|e| e.to_string())?;
    let claimed = value["metadata"]["input_digest"]
        .as_str()
        .ok_or("missing input_digest")?
        .to_owned();
    value["metadata"]
        .as_object_mut()
        .ok_or("metadata is not object")?
        .remove("input_digest");
    let mut canonical = serde_json::to_vec(&value).map_err(|e| e.to_string())?;
    canonical.push(b'\n');
    let actual = format!("{:x}", Sha256::digest(canonical));
    if actual != claimed {
        return Err(format!("digest mismatch: expected {claimed}, got {actual}"));
    }
    let fixture: Fixture = serde_json::from_slice(&raw).map_err(|e| e.to_string())?;
    if fixture.metadata.rule_version != RULE_VERSION {
        return Err("rule version mismatch".into());
    }
    Ok((fixture, claimed))
}

fn compile(actions: &[Action]) -> Result<Vec<CompactAction>, String> {
    let ids: BTreeMap<&str, usize> = actions
        .iter()
        .enumerate()
        .map(|(i, row)| (row.id.as_str(), i))
        .collect();
    actions
        .iter()
        .map(|row| {
            Ok(CompactAction {
                floor: row.floor,
                requires: row
                    .requires
                    .iter()
                    .map(|id| {
                        ids.get(id.as_str())
                            .copied()
                            .ok_or_else(|| format!("unknown requirement {id}"))
                    })
                    .collect::<Result<_, _>>()?,
                delta: [
                    row.hp,
                    row.attack,
                    row.defense,
                    row.gold,
                    row.yellow - row.consume_yellow,
                ],
                terminal: row.terminal,
                choice_group: row.choice_group.clone(),
                requires_choice: row.requires_choice.clone(),
            })
        })
        .collect()
}

fn peak_rss_bytes() -> Result<u64, String> {
    unsafe {
        let mut usage: libc::rusage = std::mem::zeroed();
        if libc::getrusage(libc::RUSAGE_SELF, &mut usage) != 0 {
            return Err("getrusage failed".into());
        }
        #[cfg(target_os = "macos")]
        {
            Ok(usage.ru_maxrss as u64)
        }
        #[cfg(not(target_os = "macos"))]
        {
            Ok(usage.ru_maxrss as u64 * 1024)
        }
    }
}
fn bit_is_set(bits: &[u64], index: usize) -> bool {
    bits[index / 64] & (1_u64 << (index % 64)) != 0
}
fn bit_set(bits: &mut [u64], index: usize) {
    bits[index / 64] |= 1_u64 << (index % 64);
}

fn prove_first_action(fixture: &Fixture) -> Value {
    let group = "opening";
    let openings: Vec<&Action> = fixture
        .actions
        .iter()
        .filter(|row| {
            row.choice_group.as_deref() == Some(group)
                && row.requires.is_empty()
                && row.requires_choice.is_none()
        })
        .collect();
    let mut candidates: Vec<Value> = Vec::new();
    for opening in openings {
        let Some(mut state) = apply_raw(fixture.initial, opening) else {
            continue;
        };
        let mut done = BTreeSet::from([opening.id.clone()]);
        let mut route = vec![opening.id.clone()];
        let mut progress = true;
        while progress {
            progress = false;
            for row in &fixture.actions {
                if done.contains(&row.id)
                    || (row.choice_group.as_deref() == Some(group) && row.id != opening.id)
                {
                    continue;
                }
                if row.requires.iter().any(|id| !done.contains(id)) {
                    continue;
                }
                if let Some(required) = &row.requires_choice {
                    if !fixture
                        .actions
                        .iter()
                        .any(|a| done.contains(&a.id) && a.choice_group.as_ref() == Some(required))
                    {
                        continue;
                    }
                }
                let Some(next) = apply_raw(state, row) else {
                    continue;
                };
                state = next;
                done.insert(row.id.clone());
                route.push(row.id.clone());
                progress = true;
            }
        }
        let excluded = fixture
            .actions
            .iter()
            .filter(|row| row.choice_group.as_deref() == Some(group) && row.id != opening.id)
            .count();
        candidates.push(json!({"first_action": opening.id, "complete": done.len() == fixture.actions.len() - excluded,
                               "terminal": state, "score": score(state), "route": route}));
    }
    candidates.sort_by(|a, b| {
        b["score"]
            .as_i64()
            .cmp(&a["score"].as_i64())
            .then_with(|| a["first_action"].as_str().cmp(&b["first_action"].as_str()))
    });
    let mut proven = candidates.len() >= 2
        && candidates
            .iter()
            .all(|row| row["complete"].as_bool() == Some(true))
        && candidates[0]["score"].as_i64() > candidates[1]["score"].as_i64();
    if proven {
        let winner: State = serde_json::from_value(candidates[0]["terminal"].clone()).unwrap();
        proven = candidates[1..].iter().all(|row| {
            let other: State = serde_json::from_value(row["terminal"].clone()).unwrap();
            dominates(winner, other)
        });
    }
    let first = if proven {
        candidates[0]["first_action"].clone()
    } else {
        Value::Null
    };
    json!({"status": if proven {"proven"} else {"unproven"}, "condition": "exact_complete_all_actions_with_strict_terminal_dominance",
           "choice_group": group, "completion_method": "source-order topological replay; all shared transitions are additive and order-independent",
           "candidate_count": candidates.len(), "candidates": candidates, "first_action": first})
}

fn bounded_search(initial: State, catalog: &[CompactAction]) -> Value {
    let node_limit = std::cmp::min(MAX_SEARCH_NODES, 64 * catalog.len());
    let words = catalog.len().div_ceil(64);
    let zero = vec![0; words];
    let mut queue = VecDeque::from([SearchNode {
        state: initial,
        done: zero.clone(),
        depth: 0,
    }]);
    let mut labels: BTreeMap<Vec<u64>, State> = BTreeMap::from([(zero, initial)]);
    let (mut nodes, mut pruned, mut candidates, mut allocations) = (0usize, 0usize, 0usize, 0usize);
    while let Some(node) = queue.pop_front() {
        if nodes == node_limit {
            queue.push_front(node);
            break;
        }
        nodes += 1;
        for (index, row) in catalog.iter().enumerate() {
            if bit_is_set(&node.done, index)
                || row
                    .requires
                    .iter()
                    .any(|need| !bit_is_set(&node.done, *need))
            {
                continue;
            }
            if let Some(group) = &row.choice_group {
                if catalog.iter().enumerate().any(|(i, other)| {
                    bit_is_set(&node.done, i) && other.choice_group.as_ref() == Some(group)
                }) {
                    continue;
                }
            }
            if let Some(required) = &row.requires_choice {
                if !catalog.iter().enumerate().any(|(i, other)| {
                    bit_is_set(&node.done, i) && other.choice_group.as_ref() == Some(required)
                }) {
                    continue;
                }
            }
            candidates += 1;
            let Some(next) = apply_compact(node.state, row) else {
                pruned += 1;
                continue;
            };
            allocations += 1; // logical candidate State
            let mut done = node.done.clone();
            bit_set(&mut done, index);
            if labels
                .get(&done)
                .is_some_and(|old| *old == next || dominates(*old, next))
            {
                pruned += 1;
                continue;
            }
            labels.insert(done.clone(), next);
            allocations += 1; // accepted label snapshot
            if !row.terminal {
                queue.push_back(SearchNode {
                    state: next,
                    done,
                    depth: node.depth + 1,
                });
                allocations += 1;
            }
        }
    }
    json!({"nodes": nodes, "node_limit": node_limit, "candidate_transitions": candidates,
           "pareto_labels": labels.len(), "pruned": pruned, "node_limit_reached": !queue.is_empty(),
           "logical_allocation_events": allocations})
}

fn calibrated<T, F: FnMut() -> T>(mut operation: F) -> (Vec<Value>, T) {
    let mut samples = Vec::new();
    let mut last = operation();
    for _ in 0..PERF_SAMPLES {
        let mut repetitions = 1usize;
        loop {
            let start = Instant::now();
            for _ in 0..repetitions {
                last = std::hint::black_box(operation());
            }
            let elapsed = start.elapsed().as_nanos();
            if elapsed >= CALIBRATION_TARGET_NS || repetitions >= MAX_REPETITIONS {
                samples.push(json!({"wall_clock_ns": elapsed, "repetitions": repetitions}));
                break;
            }
            let factor = std::cmp::max(
                2,
                (CALIBRATION_TARGET_NS / std::cmp::max(elapsed, 1)) as usize,
            );
            repetitions = std::cmp::min(MAX_REPETITIONS, repetitions.saturating_mul(factor));
        }
    }
    (samples, last)
}

fn median(mut values: Vec<f64>) -> f64 {
    values.sort_by(f64::total_cmp);
    values[values.len() / 2]
}

fn phase_worker(path: &Path, phase: &str) -> Result<Value, String> {
    let (fixture, _) = load(path)?;
    match phase {
        "compile" => {
            let start = Instant::now();
            let catalog = compile(&fixture.actions)?;
            let elapsed = start.elapsed().as_nanos();
            let estimated: usize = catalog
                .iter()
                .map(|row| 4 + row.requires.len() * 8 + 5 * 8 + 1)
                .sum();
            let checksum: i64 = catalog
                .iter()
                .map(|row| {
                    row.floor as i64 + row.delta.iter().sum::<i64>() + row.requires.len() as i64
                })
                .sum();
            Ok(
                json!({"wall_clock_ns": elapsed, "phase_peak_rss_bytes": peak_rss_bytes()?,
                "rss_measurement": {"scope": "fresh subprocess for this fixture and compile phase", "method": "getrusage(RUSAGE_SELF).ru_maxrss at phase completion", "unit": "bytes"},
                "catalog_ir_estimated_bytes": estimated, "catalog_checksum": checksum,
                "catalog_size_method": "fixed fields plus requirement indices; excludes allocator overhead and fixture strings."}),
            )
        }
        "transition" => {
            let catalog = compile(&fixture.actions)?;
            let count = catalog.len();
            let initial = fixture.initial;
            let mut successful_per_repetition = 0usize;
            let (mut samples, checksum) = calibrated(|| {
                let mut state = initial;
                let mut successful = 0usize;
                let mut checksum = CHECKSUM_SEED;
                for (ordinal, row) in catalog.iter().enumerate() {
                    match apply_compact(state, row) {
                        Some(next) => {
                            state = next;
                            successful += 1;
                        }
                        None => state = initial,
                    }
                    checksum = state_checksum(checksum, std::hint::black_box(state), ordinal);
                }
                successful_per_repetition = successful;
                checksum
            });
            for sample in &mut samples {
                let repetitions = sample["repetitions"].as_u64().unwrap();
                sample["work_units"] = json!(count as u64 * repetitions);
                sample["successes"] = json!(successful_per_repetition as u64 * repetitions);
                sample["checksum"] = json!(checksum.wrapping_mul(repetitions));
            }
            let rates: Vec<f64> = samples
                .iter()
                .map(|s| {
                    s["work_units"].as_u64().unwrap() as f64 * 1e9
                        / s["wall_clock_ns"].as_u64().unwrap() as f64
                })
                .collect();
            Ok(
                json!({"operations_per_repetition": count, "successes_per_repetition": successful_per_repetition,
                "checksum_per_repetition": checksum, "transitions_per_second": median(rates.clone()),
                "samples": samples, "sample_rates_per_second": rates,
                "sampling": {"minimum_sample_wall_clock_ns": MIN_SAMPLE_NS, "sample_count": PERF_SAMPLES, "aggregate": "median"},
                "state_copy_estimated_bytes_per_transition": std::mem::size_of::<State>(), "state_copy_method": "size_of::<State>(), five i64 fields."}),
            )
        }
        "search" => {
            let catalog = compile(&fixture.actions)?;
            let initial = fixture.initial;
            let (mut samples, result) = calibrated(|| bounded_search(initial, &catalog));
            let nodes = result["nodes"].as_u64().ok_or("nodes missing")?;
            let projection_checksum = search_checksum(&result)?;
            for sample in &mut samples {
                let repetitions = sample["repetitions"].as_u64().unwrap();
                sample["work_units"] = json!(nodes * repetitions);
                sample["projection_checksum"] =
                    json!(projection_checksum.wrapping_mul(repetitions));
            }
            let rates: Vec<f64> = samples
                .iter()
                .map(|s| {
                    s["work_units"].as_u64().unwrap() as f64 * 1e9
                        / s["wall_clock_ns"].as_u64().unwrap() as f64
                })
                .collect();
            let mut proof_times = Vec::new();
            let mut proof = Value::Null;
            for _ in 0..9 {
                let start = Instant::now();
                proof = prove_first_action(&fixture);
                proof_times.push(start.elapsed().as_nanos() as u64);
            }
            proof_times.sort();
            let allocation_events = result["logical_allocation_events"].as_u64().unwrap();
            Ok(
                json!({"nodes": nodes, "node_limit": result["node_limit"], "candidate_transitions": result["candidate_transitions"],
                "pareto_labels": result["pareto_labels"], "pruned": result["pruned"], "node_limit_reached": result["node_limit_reached"],
                "logical_allocation_events": allocation_events, "projection_checksum_per_repetition": projection_checksum,
                "nodes_per_second": median(rates.clone()), "samples": samples, "sample_rates_per_second": rates,
                "sampling": {"minimum_sample_wall_clock_ns": MIN_SAMPLE_NS, "sample_count": PERF_SAMPLES, "aggregate": "median"},
                "phase_peak_rss_bytes": peak_rss_bytes()?,
                "rss_measurement": {"scope": "fresh subprocess for this fixture and search phase", "method": "getrusage(RUSAGE_SELF).ru_maxrss at phase completion", "unit": "bytes"},
                "prune_rate": result["pruned"].as_f64().unwrap() / result["candidate_transitions"].as_f64().unwrap(),
                "per_node_allocation": {"value": allocation_events as f64 / nodes as f64, "unit": "explicit logical allocation events/expanded node", "kind": "estimated", "numerator": allocation_events, "denominator": nodes,
                    "method": "count candidate State materialization, accepted done-set/label snapshot, and enqueued Node; identical event definition in both implementations"},
                "first_action_proof_latency_ns": proof_times[4], "first_action_proof_status": proof["status"], "first_action_proof_certificate": proof,
                "proof_measurement": {"samples": 9, "aggregate": "median", "scope": "unique-root-action certificate scan only"}}),
            )
        }
        _ => Err(format!("unknown phase {phase}")),
    }
}

#[derive(Default)]
struct OracleStats {
    explored: u64,
    terminals: u64,
}
fn exhaustive(fixture: &Fixture) -> Result<Value, String> {
    let mut stats = OracleStats::default();
    let mut best: Option<(i64, Vec<String>, State)> = None;
    fn visit(
        fixture: &Fixture,
        state: State,
        done: &mut BTreeSet<String>,
        route: &mut Vec<String>,
        best: &mut Option<(i64, Vec<String>, State)>,
        stats: &mut OracleStats,
    ) {
        stats.explored += 1;
        for row in &fixture.actions {
            if done.contains(&row.id) || row.requires.iter().any(|id| !done.contains(id)) {
                continue;
            }
            let Some(next) = apply_raw(state, row) else {
                continue;
            };
            route.push(row.id.clone());
            if row.terminal {
                stats.terminals += 1;
                let candidate = (score(next), route.clone(), next);
                if best.as_ref().is_none_or(|old| {
                    candidate.0 > old.0 || (candidate.0 == old.0 && candidate.1 < old.1)
                }) {
                    *best = Some(candidate);
                }
            } else {
                done.insert(row.id.clone());
                visit(fixture, next, done, route, best, stats);
                done.remove(&row.id);
            }
            route.pop();
        }
    }
    visit(
        fixture,
        fixture.initial,
        &mut BTreeSet::new(),
        &mut Vec::new(),
        &mut best,
        &mut stats,
    );
    let (value, route, terminal) = best.ok_or("oracle has no terminal route")?;
    Ok(
        json!({"terminal": terminal, "score": value, "first_action": route[0], "route": route,
              "explored_nodes": stats.explored, "legal_terminal_routes": stats.terminals}),
    )
}

fn run_worker(path: &Path, phase: &str) -> Result<Value, String> {
    let output = Command::new(env::current_exe().map_err(|e| e.to_string())?)
        .arg("worker")
        .arg(path)
        .arg(phase)
        .output()
        .map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).into_owned());
    }
    serde_json::from_slice(&output.stdout).map_err(|e| e.to_string())
}
fn benchmark(path: &Path, threads: usize) -> Result<Value, String> {
    let (_, digest) = load(path)?;
    Ok(
        json!({"fixture": path.file_name().unwrap().to_string_lossy(), "input_digest": digest,
        "compile": run_worker(path, "compile")?, "transition": run_worker(path, "transition")?, "search": run_worker(path, "search")?,
        "parallelism": {"requested_threads": threads, "workers_used": 1, "mode": "serial-stage0; --threads is an invariance configuration, not parallel execution"}}),
    )
}
fn run(root: &Path, threads: usize) -> Result<Value, String> {
    let fixtures = [24, 100, 600]
        .iter()
        .map(|n| benchmark(&root.join(format!("synthetic-{n}.json")), threads))
        .collect::<Result<Vec<_>, _>>()?;
    let (oracle, _) = load(&root.join("oracle-small.json"))?;
    Ok(
        json!({"schema_version": RESULT_SCHEMA_VERSION, "implementation": "rust", "rule_version": RULE_VERSION, "fixture_schema": "stage0-fixture-v2",
        "search_boundary": {"node_limit_formula": "min(16384, 64 * action_count)", "order": "FIFO + source action order"},
        "phase_contract": {"version": "stage0-phase-contract-v1", "transition": "apply every catalog action in source order; reset to initial only after an illegal transition", "search": "pure bounded_search only; fixture parsing, catalog compilation, and first-action proof excluded", "proof": "separate source-order certificate scan"},
        "fixtures": fixtures, "oracle": exhaustive(&oracle)?}),
    )
}

fn write_json(value: &Value, path: Option<&Path>) -> Result<(), String> {
    let mut bytes = serde_json::to_vec(value).map_err(|e| e.to_string())?;
    bytes.push(b'\n');
    if let Some(path) = path {
        fs::write(path, bytes).map_err(|e| e.to_string())
    } else {
        print!("{}", String::from_utf8(bytes).unwrap());
        Ok(())
    }
}
fn main() {
    let args: Vec<String> = env::args().collect();
    let result = if args.get(1).map(String::as_str) == Some("worker") && args.len() == 4 {
        phase_worker(Path::new(&args[2]), &args[3]).and_then(|v| write_json(&v, None))
    } else if args.len() == 3 || (args.len() == 5 && args[3] == "--threads") {
        let threads = if args.len() == 5 {
            args[4]
                .parse::<usize>()
                .ok()
                .filter(|n| (1..=256).contains(n))
                .unwrap_or(0)
        } else {
            1
        };
        if threads == 0 {
            Err("invalid threads".into())
        } else {
            run(&PathBuf::from(&args[1]), threads)
                .and_then(|v| write_json(&v, Some(Path::new(&args[2]))))
        }
    } else {
        Err("usage: mota-stage0-ir <fixture-root> <output-json> [--threads N]".into())
    };
    if let Err(error) = result {
        eprintln!("{error}");
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_lethal_and_missing_key() {
        let state = State {
            hp: 5,
            attack: 1,
            defense: 1,
            gold: 0,
            yellow: 0,
        };
        let row = CompactAction {
            floor: 1,
            requires: vec![],
            delta: [-5, 0, 0, 0, 0],
            terminal: false,
            choice_group: None,
            requires_choice: None,
        };
        assert_eq!(apply_compact(state, &row), None);
        let keyless = CompactAction {
            delta: [0, 0, 0, 0, -1],
            ..row
        };
        assert_eq!(apply_compact(state, &keyless), None);
    }
}
