use serde_json::{Value, json};
#[cfg(test)]
use std::cell::Cell;
use std::cmp::Ordering;
use std::collections::{BTreeMap, BinaryHeap, HashMap, HashSet, VecDeque};
use std::env;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{Ipv4Addr, SocketAddrV4, TcpListener, TcpStream};
use std::sync::{Arc, Mutex};

const MAX_HEADER_BYTES: usize = 16 * 1024;
// The browser accepts an 8 MiB engine model. Reserve another MiB for the
// enclosing cycle request while keeping every request read bounded.
const MAX_BODY_BYTES: usize = 9 * 1024 * 1024;
const MAX_SHADOW_CYCLE: u64 = 9_007_199_254_740_991;
const MAX_SHADOW_CANDIDATES: usize = 256;
const MAX_GLOBAL_STATES: usize = 50_000;
const SHADOW_REASON: &str =
    "Stage3 Rust shadow runtime analyzed bounded global routes; execution remains disabled.";
const ALLOWED_ORIGIN: &str = "https://h5mota.com";
const ALLOWED_REQUEST_HEADERS: [&str; 2] = ["content-type", "x-mota-lab"];
#[cfg(test)]
thread_local! {
    static PHASE2_CALLS: Cell<usize> = const { Cell::new(0) };
    static PHASE_A_DROPPED: Cell<bool> = const { Cell::new(false) };
    static PHASE2_SAW_PHASE_A_DROPPED: Cell<bool> = const { Cell::new(false) };
}

#[derive(Default)]
struct ShadowState {
    cycle: u64,
}

struct HttpRequest {
    method: String,
    path: String,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
    has_content_length: bool,
}

struct HttpFailure {
    status: u16,
    body: Value,
    cors_headers: Vec<(&'static str, &'static str)>,
}

fn usage() -> &'static str {
    "usage: mota-shadow-runtime [--port PORT]"
}

fn parse_port() -> Result<u16, String> {
    let mut port = env::var("MOTA_SHADOW_PORT")
        .ok()
        .map(|value| {
            value
                .parse::<u16>()
                .map_err(|_| "MOTA_SHADOW_PORT must be a port".to_owned())
        })
        .transpose()?
        .unwrap_or(18724);
    let mut args = env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--port" => {
                let value = args.next().ok_or_else(|| usage().to_owned())?;
                port = value
                    .parse::<u16>()
                    .map_err(|_| "--port must be a port".to_owned())?;
            }
            "--help" | "-h" => return Err(usage().to_owned()),
            _ => return Err(usage().to_owned()),
        }
    }
    Ok(port)
}

fn write_response(
    stream: &mut TcpStream,
    status: u16,
    body: Option<Value>,
    cors_headers: &[(&'static str, &'static str)],
) -> std::io::Result<()> {
    let payload = body
        .as_ref()
        .map(|body| serde_json::to_vec(body).expect("response JSON is serializable"));
    let phrase = match status {
        200 => "OK",
        204 => "No Content",
        400 => "Bad Request",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        413 => "Payload Too Large",
        _ => "Internal Server Error",
    };
    write!(stream, "HTTP/1.1 {status} {phrase}\r\n")?;
    if body.is_some() {
        write!(stream, "Content-Type: application/json\r\n")?;
    }
    for (name, value) in cors_headers {
        write!(stream, "{name}: {value}\r\n")?;
    }
    write!(
        stream,
        "Content-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n",
        payload.as_ref().map_or(0, Vec::len)
    )?;
    if let Some(payload) = payload {
        stream.write_all(&payload)?;
    }
    Ok(())
}

fn error(code: &str, reason: &str) -> Value {
    json!({"status": "error", "error_code": code, "reason": reason, "errors": []})
}

fn failure(status: u16, code: &str, reason: &str, headers: &[(String, String)]) -> HttpFailure {
    HttpFailure {
        status,
        body: error(code, reason),
        cors_headers: cors_headers_for_headers(headers),
    }
}

fn read_request(stream: &mut TcpStream) -> Result<HttpRequest, HttpFailure> {
    let mut reader = BufReader::new(stream);
    let mut headers = Vec::new();
    let mut request_line = String::new();
    let size = reader.read_line(&mut request_line).map_err(|_| {
        failure(
            400,
            "MALFORMED_HTTP",
            "Unable to read request line.",
            &headers,
        )
    })?;
    if size == 0 || request_line.len() > MAX_HEADER_BYTES {
        return Err(failure(
            400,
            "MALFORMED_HTTP",
            "Missing or oversized request line.",
            &headers,
        ));
    }
    let mut pieces = request_line.trim_end().split_whitespace();
    let method = pieces.next().unwrap_or_default().to_owned();
    let path = pieces.next().unwrap_or_default().to_owned();
    let version = pieces.next().unwrap_or_default();
    if pieces.next().is_some()
        || method.is_empty()
        || path.is_empty()
        || !version.starts_with("HTTP/")
    {
        return Err(failure(
            400,
            "MALFORMED_HTTP",
            "Invalid request line.",
            &headers,
        ));
    }

    let mut content_length = None;
    let mut body_too_large = false;
    let mut header_bytes = request_line.len();
    loop {
        let mut line = String::new();
        let size = reader.read_line(&mut line).map_err(|_| {
            failure(
                400,
                "MALFORMED_HTTP",
                "Unable to read request headers.",
                &headers,
            )
        })?;
        if size == 0 {
            return Err(failure(
                400,
                "MALFORMED_HTTP",
                "Headers ended unexpectedly.",
                &headers,
            ));
        }
        header_bytes += size;
        if header_bytes > MAX_HEADER_BYTES {
            return Err(failure(
                413,
                "REQUEST_HEADERS_TOO_LARGE",
                "Request headers exceed the shadow runtime limit.",
                &headers,
            ));
        }
        if line == "\r\n" || line == "\n" {
            break;
        }
        let Some((name, value)) = line.split_once(':') else {
            return Err(failure(
                400,
                "MALFORMED_HTTP",
                "Invalid request header.",
                &headers,
            ));
        };
        let name = name.trim();
        let value = value.trim();
        if name.eq_ignore_ascii_case("content-length") {
            if content_length.is_some() {
                return Err(failure(
                    400,
                    "MALFORMED_HTTP",
                    "Duplicate Content-Length header.",
                    &headers,
                ));
            }
            let length = value.parse::<usize>().map_err(|_| {
                failure(
                    400,
                    "MALFORMED_HTTP",
                    "Content-Length must be a non-negative integer.",
                    &headers,
                )
            })?;
            if length > MAX_BODY_BYTES {
                body_too_large = true;
            }
            content_length = Some(length);
        }
        headers.push((name.to_ascii_lowercase(), value.to_owned()));
    }
    if body_too_large {
        return Err(failure(
            413,
            "REQUEST_BODY_TOO_LARGE",
            "Request body exceeds the shadow runtime limit.",
            &headers,
        ));
    }
    let length = content_length.unwrap_or(0);
    let mut body = vec![0_u8; length];
    reader.read_exact(&mut body).map_err(|_| {
        failure(
            400,
            "MALFORMED_HTTP",
            "Request body ended unexpectedly.",
            &headers,
        )
    })?;
    Ok(HttpRequest {
        method,
        path,
        headers,
        body,
        has_content_length: content_length.is_some(),
    })
}

fn header_from_headers<'a>(headers: &'a [(String, String)], name: &str) -> Option<&'a str> {
    headers
        .iter()
        .find_map(|(candidate, value)| (candidate == name).then_some(value.as_str()))
}

fn header<'a>(request: &'a HttpRequest, name: &str) -> Option<&'a str> {
    header_from_headers(&request.headers, name)
}

fn cors_headers_for_headers(headers: &[(String, String)]) -> Vec<(&'static str, &'static str)> {
    if header_from_headers(headers, "origin") == Some(ALLOWED_ORIGIN) {
        vec![
            ("Access-Control-Allow-Origin", ALLOWED_ORIGIN),
            ("Vary", "Origin"),
        ]
    } else {
        Vec::new()
    }
}

fn cors_headers_for_actual_request(request: &HttpRequest) -> Vec<(&'static str, &'static str)> {
    cors_headers_for_headers(&request.headers)
}

fn valid_json_content_type(request: &HttpRequest) -> bool {
    header(request, "content-type")
        .map(|value| {
            value
                .split_once(';')
                .map_or(value, |(media_type, _)| media_type)
        })
        .is_some_and(|media_type| media_type.trim().eq_ignore_ascii_case("application/json"))
}

fn valid_actual_origin(request: &HttpRequest) -> bool {
    header(request, "origin").map_or(true, |origin| origin == ALLOWED_ORIGIN)
}

fn valid_preflight(request: &HttpRequest) -> bool {
    if request.path != "/cycle"
        || header(request, "origin") != Some(ALLOWED_ORIGIN)
        || !header(request, "access-control-request-method")
            .is_some_and(|method| method.eq_ignore_ascii_case("POST"))
    {
        return false;
    }
    header(request, "access-control-request-headers")
        .map(|headers| {
            headers.split(',').all(|header| {
                let header = header.trim();
                !header.is_empty()
                    && ALLOWED_REQUEST_HEADERS
                        .iter()
                        .any(|allowed| header.eq_ignore_ascii_case(allowed))
            })
        })
        .unwrap_or(true)
}

fn preflight_headers() -> [(&'static str, &'static str); 5] {
    [
        ("Access-Control-Allow-Origin", ALLOWED_ORIGIN),
        ("Access-Control-Allow-Methods", "POST"),
        ("Access-Control-Allow-Headers", "Content-Type, X-Mota-Lab"),
        ("Access-Control-Max-Age", "600"),
        (
            "Vary",
            "Origin, Access-Control-Request-Method, Access-Control-Request-Headers",
        ),
    ]
}

fn required_string<'a>(
    object: &'a serde_json::Map<String, Value>,
    name: &str,
) -> Result<&'a str, Value> {
    object
        .get(name)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty() && value.len() <= 256)
        .ok_or_else(|| error("INVALID_REQUEST", &format!("Missing or invalid {name}.")))
}

fn non_negative_u64(value: Option<&Value>) -> Option<u64> {
    value.and_then(Value::as_u64)
}

fn position_key(x: u64, y: u64) -> (u64, u64) {
    (x, y)
}

fn valid_cells(observation: &serde_json::Map<String, Value>) -> Result<HashSet<(u64, u64)>, Value> {
    let dimensions = observation
        .get("dimensions")
        .and_then(Value::as_object)
        .ok_or_else(|| error("INVALID_REQUEST", "Observation requires dimensions."))?;
    let width = non_negative_u64(dimensions.get("width"))
        .filter(|value| (1..=256).contains(value))
        .ok_or_else(|| error("INVALID_REQUEST", "Observation width is invalid."))?;
    let height = non_negative_u64(dimensions.get("height"))
        .filter(|value| (1..=256).contains(value))
        .ok_or_else(|| error("INVALID_REQUEST", "Observation height is invalid."))?;
    let topology = observation
        .get("topology")
        .and_then(Value::as_object)
        .ok_or_else(|| error("INVALID_REQUEST", "Observation requires topology."))?;
    match topology.get("kind").and_then(Value::as_str) {
        Some("rectangle") => Ok((0..height)
            .flat_map(|y| (0..width).map(move |x| position_key(x, y)))
            .collect()),
        Some("valid_cells") => {
            let cells = topology
                .get("valid_cells")
                .and_then(Value::as_array)
                .ok_or_else(|| error("INVALID_REQUEST", "valid_cells topology is incomplete."))?;
            let mut result = HashSet::with_capacity(cells.len());
            for cell in cells {
                let cell = cell
                    .as_object()
                    .ok_or_else(|| error("INVALID_REQUEST", "Topology cell is invalid."))?;
                let x = non_negative_u64(cell.get("x"))
                    .filter(|value| *value < width)
                    .ok_or_else(|| error("INVALID_REQUEST", "Topology cell x is invalid."))?;
                let y = non_negative_u64(cell.get("y"))
                    .filter(|value| *value < height)
                    .ok_or_else(|| error("INVALID_REQUEST", "Topology cell y is invalid."))?;
                result.insert(position_key(x, y));
            }
            Ok(result)
        }
        _ => Err(error(
            "INVALID_REQUEST",
            "Observation topology kind is invalid.",
        )),
    }
}

fn candidate_kind(block: &serde_json::Map<String, Value>) -> Option<&'static str> {
    if block.get("enemy").is_some_and(|value| !value.is_null())
        || block.get("trigger").and_then(Value::as_str) == Some("battle")
    {
        return Some("enemy");
    }
    if block.get("trigger").and_then(Value::as_str) == Some("openDoor") {
        let id = block
            .get("id")
            .and_then(Value::as_str)?
            .to_ascii_lowercase();
        if ["yellow", "blue", "red"]
            .iter()
            .any(|color| id.contains(color) && id.contains("door"))
        {
            return Some("door");
        }
        return None;
    }
    if block.get("trigger").and_then(Value::as_str) == Some("getItem") {
        return Some("resource");
    }
    if block.get("trigger").and_then(Value::as_str) == Some("changeFloor") {
        return Some("stair");
    }
    None
}

fn door_color(block_id: &str) -> Option<&'static str> {
    let id = block_id.to_ascii_lowercase();
    ["yellow", "blue", "red"]
        .into_iter()
        .find(|color| id.contains(color) && id.contains("door"))
}

fn key_count(observation: &serde_json::Map<String, Value>, color: &str) -> u64 {
    observation
        .get("keys")
        .and_then(Value::as_object)
        .and_then(|keys| keys.get(color))
        .and_then(Value::as_u64)
        .unwrap_or(0)
}

fn candidate_json(
    floor_id: &str,
    observation: &serde_json::Map<String, Value>,
    block: &serde_json::Map<String, Value>,
    kind: &str,
    distance: u64,
) -> Result<Value, Value> {
    let x = non_negative_u64(block.get("x"))
        .ok_or_else(|| error("INVALID_REQUEST", "Block x is invalid."))?;
    let y = non_negative_u64(block.get("y"))
        .ok_or_else(|| error("INVALID_REQUEST", "Block y is invalid."))?;
    let numeric_id = non_negative_u64(block.get("numeric_id"))
        .ok_or_else(|| error("INVALID_REQUEST", "Block numeric_id is invalid."))?;
    let block_id = required_string(block, "id")?;
    let hp = observation
        .get("hero")
        .and_then(Value::as_object)
        .and_then(|hero| hero.get("hp"))
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let mut hp_loss = Value::from(0);
    let mut feasibility = "known_feasible";
    let mut yellow = 0_u64;
    let mut blue = 0_u64;
    let mut red = 0_u64;
    match kind {
        "enemy" => match block.get("damage").and_then(Value::as_u64) {
            Some(damage) => {
                hp_loss = Value::from(damage);
                if damage >= hp {
                    feasibility = "known_lethal";
                }
            }
            None => {
                hp_loss = Value::Null;
                feasibility = "unknown_cost";
            }
        },
        "door" => {
            let Some(color) = door_color(block_id) else {
                return Err(error(
                    "INVALID_REQUEST",
                    "Recognized door has no supported color.",
                ));
            };
            match color {
                "yellow" => yellow = 1,
                "blue" => blue = 1,
                "red" => red = 1,
                _ => unreachable!(),
            }
            if key_count(observation, color) == 0 {
                feasibility = "missing_key";
            }
        }
        "resource" | "stair" => {}
        _ => {
            return Err(error(
                "INVALID_REQUEST",
                "Unsupported shadow candidate kind.",
            ));
        }
    }
    Ok(json!({
        "candidate_id": format!("{floor_id}:{kind}:{x},{y}:{numeric_id}:{block_id}"),
        "kind": kind,
        "block_id": block_id,
        "numeric_id": numeric_id,
        "x": x,
        "y": y,
        "distance": distance,
        "feasibility": feasibility,
        "hp_loss": hp_loss,
        "key_cost": {"yellow": yellow, "blue": blue, "red": red}
    }))
}

fn analyze_current_floor(
    observation: &serde_json::Map<String, Value>,
    floor_id: &str,
) -> Result<Value, Value> {
    let cells = valid_cells(observation)?;
    let hero = observation
        .get("hero")
        .and_then(Value::as_object)
        .and_then(|hero| hero.get("loc"))
        .and_then(Value::as_object)
        .ok_or_else(|| error("INVALID_REQUEST", "Observation requires hero.loc."))?;
    let start = (
        non_negative_u64(hero.get("x"))
            .ok_or_else(|| error("INVALID_REQUEST", "Hero x is invalid."))?,
        non_negative_u64(hero.get("y"))
            .ok_or_else(|| error("INVALID_REQUEST", "Hero y is invalid."))?,
    );
    if !cells.contains(&start) {
        return Err(error(
            "INVALID_REQUEST",
            "Hero is outside the current-floor topology.",
        ));
    }

    let blocks = observation
        .get("blocks")
        .and_then(Value::as_array)
        .ok_or_else(|| error("INVALID_REQUEST", "Observation requires blocks."))?;
    let mut blocks_by_position = HashMap::with_capacity(blocks.len());
    for block in blocks {
        let block = block
            .as_object()
            .ok_or_else(|| error("INVALID_REQUEST", "Observation block is invalid."))?;
        let x = non_negative_u64(block.get("x"))
            .ok_or_else(|| error("INVALID_REQUEST", "Block x is invalid."))?;
        let y = non_negative_u64(block.get("y"))
            .ok_or_else(|| error("INVALID_REQUEST", "Block y is invalid."))?;
        blocks_by_position.insert((x, y), block);
    }

    let mut distances = HashMap::from([(start, 0_u64)]);
    let mut queue = VecDeque::from([start]);
    let mut candidates = HashMap::<(u64, u64), Value>::new();
    const NEIGHBORS: [(i64, i64); 4] = [(0, -1), (-1, 0), (1, 0), (0, 1)];
    while let Some((x, y)) = queue.pop_front() {
        let distance = distances[&(x, y)];
        for (dx, dy) in NEIGHBORS {
            let Some(nx) = i64::try_from(x)
                .ok()
                .and_then(|value| value.checked_add(dx))
            else {
                continue;
            };
            let Some(ny) = i64::try_from(y)
                .ok()
                .and_then(|value| value.checked_add(dy))
            else {
                continue;
            };
            let Ok(nx) = u64::try_from(nx) else { continue };
            let Ok(ny) = u64::try_from(ny) else { continue };
            let position = (nx, ny);
            if !cells.contains(&position) {
                continue;
            }
            if let Some(block) = blocks_by_position.get(&position) {
                if let Some(kind) = candidate_kind(block) {
                    candidates.entry(position).or_insert(candidate_json(
                        floor_id,
                        observation,
                        block,
                        kind,
                        distance + 1,
                    )?);
                    continue;
                }
                if block.get("trigger").is_some_and(|value| !value.is_null())
                    || block.get("shop_id").is_some()
                    || block
                        .get("no_pass")
                        .and_then(Value::as_bool)
                        .unwrap_or(true)
                {
                    continue;
                }
            }
            if distances.insert(position, distance + 1).is_none() {
                queue.push_back(position);
            }
        }
    }

    let total_candidate_count = candidates.len();
    let mut candidates: Vec<Value> = candidates.into_values().collect();
    candidates.sort_by(|left, right| {
        let key = |value: &Value| {
            (
                value["distance"].as_u64().unwrap_or(u64::MAX),
                value["y"].as_u64().unwrap_or(u64::MAX),
                value["x"].as_u64().unwrap_or(u64::MAX),
                value["kind"].as_str().unwrap_or_default().to_owned(),
                value["block_id"].as_str().unwrap_or_default().to_owned(),
            )
        };
        key(left).cmp(&key(right))
    });
    candidates.truncate(MAX_SHADOW_CANDIDATES);
    Ok(json!({
        "scope": "current_floor_immediate",
        "reachable_cell_count": distances.len(),
        "candidate_limit": MAX_SHADOW_CANDIDATES,
        "total_candidate_count": total_candidate_count,
        "truncated": total_candidate_count > MAX_SHADOW_CANDIDATES,
        "candidates": candidates
    }))
}

#[derive(Clone, Debug)]
struct SolverBlock {
    floor: String,
    x: u64,
    y: u64,
    id: String,
    kind: String,
    data: Value,
    state_slot: Option<usize>,
}

fn audited_event_state_target(floor: &str, x: u64, y: u64) -> bool {
    matches!(
        (floor, x, y),
        ("MT20", 6, 8)
            | ("MT16", 5, 5)
            | ("MT2", 2, 7)
            | ("MT18", 6, 9)
            | ("MT18", 6, 10)
            | ("MT18", 11, 11)
            | ("MT23w", 5, 6)
            | ("MT23e", 7, 6)
            | ("MT_1", 5..=7, 2..=4)
    )
}

fn block_needs_state_slot(block: &SolverBlock) -> bool {
    matches!(block.kind.as_str(), "door" | "enemy" | "resource" | "event")
        || block.data.get("initial_active").and_then(Value::as_bool) == Some(false)
        || audited_event_state_target(&block.floor, block.x, block.y)
}

#[derive(Clone, Debug)]
struct SolverFloor {
    width: u64,
    height: u64,
    cells: HashSet<(u64, u64)>,
    blocks: Vec<usize>,
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
struct ConsumedBits {
    bit_len: usize,
    words: Arc<Vec<u64>>,
}

impl ConsumedBits {
    fn new(bit_len: usize) -> Self {
        Self {
            bit_len,
            words: Arc::new(vec![0; bit_len / 64 + usize::from(bit_len % 64 != 0)]),
        }
    }

    #[cfg(test)]
    fn from_bools(values: &[bool]) -> Self {
        let mut bits = Self::new(values.len());
        let changes: Vec<_> = values
            .iter()
            .enumerate()
            .filter_map(|(slot, value)| value.then_some((slot, true)))
            .collect();
        bits.set_many(&changes)
            .expect("slots from the bitset length are valid");
        bits
    }

    fn read(&self, slot: usize) -> Option<bool> {
        (slot < self.bit_len)
            .then(|| {
                self.words
                    .get(slot / 64)
                    .map(|word| word & (1u64 << (slot % 64)) != 0)
            })
            .flatten()
    }

    fn set(&mut self, slot: usize, value: bool) -> Result<(), ()> {
        self.set_many(&[(slot, value)])
    }

    fn set_many(&mut self, changes: &[(usize, bool)]) -> Result<(), ()> {
        if changes
            .iter()
            .any(|(slot, _)| *slot >= self.bit_len || self.words.get(*slot / 64).is_none())
        {
            return Err(());
        }
        let words = Arc::make_mut(&mut self.words);
        for (slot, value) in changes {
            let word = &mut words[*slot / 64];
            let mask = 1u64 << (*slot % 64);
            if *value {
                *word |= mask;
            } else {
                *word &= !mask;
            }
        }
        if let Some(last) = words.last_mut() {
            let remainder = self.bit_len % 64;
            if remainder != 0 {
                *last &= (1u64 << remainder) - 1;
            }
        }
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
struct SolverState {
    floor: String,
    x: u64,
    y: u64,
    hp: F64Bits,
    attack: F64Bits,
    defense: F64Bits,
    level: u64,
    gold: u64,
    experience: u64,
    yellow: u64,
    blue: u64,
    red: u64,
    inventory: Arc<Vec<(String, u64)>>,
    consumed: ConsumedBits,
    shop_counts: Arc<Vec<u64>>,
    flags: Arc<Vec<(String, u64)>>,
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
struct StructuralKey {
    floor: String,
    x: u64,
    y: u64,
    inventory: Arc<Vec<(String, u64)>>,
    consumed: ConsumedBits,
    shop_counts: Arc<Vec<u64>>,
    level: u64,
    flags: Arc<Vec<(String, u64)>>,
}

impl From<&SolverState> for StructuralKey {
    fn from(state: &SolverState) -> Self {
        Self {
            floor: state.floor.clone(),
            x: state.x,
            y: state.y,
            inventory: state.inventory.clone(),
            consumed: state.consumed.clone(),
            shop_counts: state.shop_counts.clone(),
            level: state.level,
            flags: state.flags.clone(),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
struct F64Bits(u64);

impl F64Bits {
    fn new(value: f64) -> Option<Self> {
        (value.is_finite() && value >= 0.0).then_some(Self(value.to_bits()))
    }
    fn get(self) -> f64 {
        f64::from_bits(self.0)
    }
    fn add(self, value: f64) -> Option<Self> {
        Self::new(self.get() + value)
    }
    fn mul(self, value: f64) -> Option<Self> {
        Self::new(self.get() * value)
    }
    fn div(self, value: f64) -> Option<Self> {
        Self::new(self.get() / value)
    }
}

#[derive(Clone)]
enum BlockRouteAction {
    Door { yellow: u64, blue: u64, red: u64 },
    Resource,
    Enemy { hp_loss: F64Bits },
    Transition,
    Event { event_id: String },
}

#[derive(Clone)]
struct ShopRouteEffect {
    field: String,
    amount: u64,
}

#[derive(Clone)]
enum RouteAction {
    Block {
        index: usize,
        action: BlockRouteAction,
    },
    Shop {
        floor: String,
        shop_id: String,
        choice_id: String,
        currency: String,
        cost: u64,
        purchase_count_before: u64,
        effects: Vec<ShopRouteEffect>,
    },
}

#[derive(Clone)]
enum PendingAction {
    Block {
        index: usize,
        adjacent: (u64, u64),
    },
    Shop {
        shop_index: usize,
        choice_index: usize,
        choice_offset: usize,
        floor: String,
        adjacent: (u64, u64),
    },
}

struct PendingCandidate {
    source: usize,
    action: PendingAction,
}

#[derive(Clone, Copy, Debug)]
struct NumericObjective {
    attack_and_defense: f64,
    balanced_stat: f64,
    hp: f64,
}

impl NumericObjective {
    fn from_state(state: &SolverState) -> Self {
        Self {
            attack_and_defense: state.attack.get() + state.defense.get(),
            balanced_stat: state.attack.get().min(state.defense.get()),
            hp: state.hp.get(),
        }
    }

    fn cmp(self, other: Self) -> Ordering {
        self.attack_and_defense
            .total_cmp(&other.attack_and_defense)
            .then(self.balanced_stat.total_cmp(&other.balanced_stat))
            .then(self.hp.total_cmp(&other.hp))
    }

    fn matches(self, other: Self) -> bool {
        self.cmp(other).is_eq()
    }
}

#[derive(Clone)]
enum RouteStepSemantic {
    Door {
        floor_id: String,
        x: u64,
        y: u64,
        block_id: String,
        yellow: u64,
        blue: u64,
        red: u64,
    },
    Resource {
        floor_id: String,
        x: u64,
        y: u64,
        block_id: String,
        delta: Value,
    },
    Enemy {
        floor_id: String,
        x: u64,
        y: u64,
        block_id: String,
        hp_loss: F64Bits,
    },
    Transition {
        floor_id: String,
        x: u64,
        y: u64,
        block_id: String,
    },
    Event {
        floor_id: String,
        x: u64,
        y: u64,
        block_id: String,
        event_id: String,
    },
    Shop {
        floor_id: String,
        shop_id: String,
        choice_id: String,
        currency: String,
        cost: u64,
        purchase_count_before: u64,
        effects: Vec<ShopRouteEffect>,
    },
    Terminal {
        floor_id: String,
        x: u64,
        y: u64,
    },
}

impl RouteStepSemantic {
    // This is the protocol's stable route-step encoding. Object keys are later
    // sorted explicitly by `canonical_json_bytes`, rather than relying on the
    // insertion order of a serde_json map.
    fn json_value(&self) -> Value {
        match self {
            Self::Door {
                floor_id,
                x,
                y,
                block_id,
                yellow,
                blue,
                red,
            } => json!({"step_kind":"door","floor_id":floor_id,"x":x,"y":y,
                "block_id":block_id,"details":{"key_cost":{"yellow":yellow,"blue":blue,"red":red}}}),
            Self::Resource {
                floor_id,
                x,
                y,
                block_id,
                delta,
            } => json!({"step_kind":"resource","floor_id":floor_id,"x":x,"y":y,
                "block_id":block_id,"details":delta}),
            Self::Enemy {
                floor_id,
                x,
                y,
                block_id,
                hp_loss,
            } => json!({"step_kind":"enemy","floor_id":floor_id,"x":x,"y":y,
                "block_id":block_id,"details":{"hp_loss":hp_loss.get()}}),
            Self::Transition {
                floor_id,
                x,
                y,
                block_id,
            } => json!({"step_kind":"transition","floor_id":floor_id,"x":x,"y":y,
                "block_id":block_id,"details":{}}),
            Self::Event {
                floor_id,
                x,
                y,
                block_id,
                event_id,
            } => json!({"step_kind":"event","floor_id":floor_id,"x":x,"y":y,
                "block_id":block_id,"details":{"event_id":event_id}}),
            Self::Shop {
                floor_id,
                shop_id,
                choice_id,
                currency,
                cost,
                purchase_count_before,
                effects,
            } => json!({"step_kind":"shop","floor_id":floor_id,"shop_id":shop_id,
                "choice_id":choice_id,"details":{"currency":currency,"cost":cost,
                "purchase_count_before":purchase_count_before,"effects":effects.iter()
                    .map(|effect| json!({"field":effect.field,"amount":effect.amount})).collect::<Vec<_>>()}}),
            Self::Terminal { floor_id, x, y } => json!({"step_kind":"terminal","floor_id":floor_id,
                "x":x,"y":y,"details":{}}),
        }
    }
}

fn canonical_json_bytes(value: &Value, output: &mut Vec<u8>) {
    match value {
        Value::Array(items) => {
            output.push(b'[');
            for (index, item) in items.iter().enumerate() {
                if index != 0 {
                    output.push(b',');
                }
                canonical_json_bytes(item, output);
            }
            output.push(b']');
        }
        Value::Object(object) => {
            output.push(b'{');
            let mut fields: Vec<_> = object.iter().collect();
            fields.sort_unstable_by(|(left, _), (right, _)| left.cmp(right));
            for (index, (name, item)) in fields.into_iter().enumerate() {
                if index != 0 {
                    output.push(b',');
                }
                serde_json::to_writer(&mut *output, name)
                    .expect("route field names are serializable");
                output.push(b':');
                canonical_json_bytes(item, output);
            }
            output.push(b'}');
        }
        scalar => serde_json::to_writer(&mut *output, scalar)
            .expect("route scalar values are serializable"),
    }
}

#[derive(Clone)]
struct RouteStepKey {
    // Keep the typed protocol payload with the key so every currently supported
    // route step has an explicit, reviewable variant. `canonical` is an
    // independently generated stable encoding used only for ordering.
    _semantic: RouteStepSemantic,
    canonical: Arc<[u8]>,
}

impl RouteStepKey {
    fn new(semantic: RouteStepSemantic) -> Self {
        let mut canonical = Vec::new();
        canonical_json_bytes(&semantic.json_value(), &mut canonical);
        Self {
            _semantic: semantic,
            canonical: Arc::from(canonical),
        }
    }
}

impl PartialEq for RouteStepKey {
    fn eq(&self, other: &Self) -> bool {
        self.canonical == other.canonical
    }
}

impl Eq for RouteStepKey {}

impl Ord for RouteStepKey {
    fn cmp(&self, other: &Self) -> Ordering {
        self.canonical.cmp(&other.canonical)
    }
}

impl PartialOrd for RouteStepKey {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

#[derive(Clone)]
struct RouteStep {
    value: Value,
    key: RouteStepKey,
}

impl RouteStep {
    fn new(semantic: RouteStepSemantic) -> Self {
        let value = semantic.json_value();
        let key = RouteStepKey::new(semantic);
        Self { value, key }
    }
}

fn route_action_step(action: &RouteAction, blocks: &[SolverBlock]) -> RouteStep {
    match action {
        RouteAction::Block { index, action } => {
            let block = &blocks[*index];
            let semantic = match action {
                BlockRouteAction::Door { yellow, blue, red } => RouteStepSemantic::Door {
                    floor_id: block.floor.clone(),
                    x: block.x,
                    y: block.y,
                    block_id: block.id.clone(),
                    yellow: *yellow,
                    blue: *blue,
                    red: *red,
                },
                BlockRouteAction::Resource => RouteStepSemantic::Resource {
                    floor_id: block.floor.clone(),
                    x: block.x,
                    y: block.y,
                    block_id: block.id.clone(),
                    delta: block.data["delta"].clone(),
                },
                BlockRouteAction::Enemy { hp_loss } => RouteStepSemantic::Enemy {
                    floor_id: block.floor.clone(),
                    x: block.x,
                    y: block.y,
                    block_id: block.id.clone(),
                    hp_loss: *hp_loss,
                },
                BlockRouteAction::Transition => RouteStepSemantic::Transition {
                    floor_id: block.floor.clone(),
                    x: block.x,
                    y: block.y,
                    block_id: block.id.clone(),
                },
                BlockRouteAction::Event { event_id } => RouteStepSemantic::Event {
                    floor_id: block.floor.clone(),
                    x: block.x,
                    y: block.y,
                    block_id: block.id.clone(),
                    event_id: event_id.clone(),
                },
            };
            RouteStep::new(semantic)
        }
        RouteAction::Shop {
            floor,
            shop_id,
            choice_id,
            currency,
            cost,
            purchase_count_before,
            effects,
        } => RouteStep::new(RouteStepSemantic::Shop {
            floor_id: floor.clone(),
            shop_id: shop_id.clone(),
            choice_id: choice_id.clone(),
            currency: currency.clone(),
            cost: *cost,
            purchase_count_before: *purchase_count_before,
            effects: effects.clone(),
        }),
    }
}

#[cfg(test)]
fn route_action_json(action: &RouteAction, blocks: &[SolverBlock]) -> Value {
    route_action_step(action, blocks).value
}

#[derive(Clone)]
struct ConnectivityFloor {
    width: usize,
    height: usize,
    cells: Vec<bool>,
    blocks_by_cell: Vec<Vec<usize>>,
}

struct ConnectivityIndex {
    floors: HashMap<String, ConnectivityFloor>,
    reversible: Vec<Option<usize>>,
}

#[derive(Clone)]
struct ReachBoundary {
    index: usize,
    adjacent: (u64, u64),
    navigation: Vec<usize>,
}

#[derive(Clone)]
struct ReachTerminal {
    floor: String,
    position: (u64, u64),
    navigation: Vec<usize>,
}

struct ConnectivityView {
    representative: (String, u64, u64),
    boundaries: Vec<ReachBoundary>,
    shops: HashMap<String, (String, (u64, u64), Vec<usize>)>,
    terminals: Vec<ReachTerminal>,
}

fn solver_u64(object: &serde_json::Map<String, Value>, name: &str) -> Result<u64, String> {
    object
        .get(name)
        .and_then(Value::as_u64)
        .ok_or_else(|| format!("invalid {name}"))
}

fn parse_solver_world(
    observation: &serde_json::Map<String, Value>,
) -> Result<
    (
        HashMap<String, SolverFloor>,
        Vec<SolverBlock>,
        usize,
        Value,
        Vec<Value>,
        Vec<Value>,
    ),
    String,
> {
    let model = observation
        .get("engine_model")
        .and_then(Value::as_object)
        .and_then(|model| model.get("solver_model"))
        .and_then(Value::as_object)
        .ok_or_else(|| "solver_model_missing".to_owned())?;
    let terminal = model
        .get("terminal")
        .filter(|value| !value.is_null())
        .cloned()
        .ok_or_else(|| "terminal_unsupported".to_owned())?;
    let blockers = model
        .get("blockers")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let shops = model
        .get("shops")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut floors = HashMap::new();
    let mut blocks = Vec::new();
    for floor in model
        .get("floors")
        .and_then(Value::as_array)
        .ok_or_else(|| "floors_missing".to_owned())?
    {
        let floor = floor
            .as_object()
            .ok_or_else(|| "floor_invalid".to_owned())?;
        let floor_id = required_string(floor, "floor_id")
            .map_err(|_| "floor_id_invalid".to_owned())?
            .to_owned();
        let width = solver_u64(floor, "width")?;
        let height = solver_u64(floor, "height")?;
        let topology = floor
            .get("topology")
            .and_then(Value::as_object)
            .ok_or_else(|| "topology_missing".to_owned())?;
        let cells = match topology.get("kind").and_then(Value::as_str) {
            Some("rectangle") => (0..height)
                .flat_map(|y| (0..width).map(move |x| (x, y)))
                .collect(),
            Some("valid_cells") => topology
                .get("valid_cells")
                .and_then(Value::as_array)
                .ok_or_else(|| "valid_cells_missing".to_owned())?
                .iter()
                .map(|cell| {
                    let cell = cell
                        .as_object()
                        .ok_or_else(|| "valid_cell_invalid".to_owned())?;
                    Ok((solver_u64(cell, "x")?, solver_u64(cell, "y")?))
                })
                .collect::<Result<HashSet<_>, String>>()?,
            _ => return Err("topology_unsupported".to_owned()),
        };
        let mut indices = Vec::new();
        for block in floor
            .get("blocks")
            .and_then(Value::as_array)
            .ok_or_else(|| "blocks_missing".to_owned())?
        {
            let object = block
                .as_object()
                .ok_or_else(|| "block_invalid".to_owned())?;
            let index = blocks.len();
            blocks.push(SolverBlock {
                floor: floor_id.clone(),
                x: solver_u64(object, "x")?,
                y: solver_u64(object, "y")?,
                id: required_string(object, "block_id")
                    .map_err(|_| "block_id_invalid".to_owned())?
                    .to_owned(),
                kind: required_string(object, "kind")
                    .map_err(|_| "block_kind_invalid".to_owned())?
                    .to_owned(),
                data: block.clone(),
                state_slot: None,
            });
            indices.push(index);
        }
        floors.insert(
            floor_id,
            SolverFloor {
                width,
                height,
                cells,
                blocks: indices,
            },
        );
    }
    let mut next_slot = 0;
    for block in &mut blocks {
        if block_needs_state_slot(block) {
            block.state_slot = Some(next_slot);
            next_slot += 1;
        }
    }
    Ok((floors, blocks, next_slot, terminal, shops, blockers))
}

fn transition_target(block: &SolverBlock) -> Option<(&str, u64, u64)> {
    let target = block.data.get("target")?.as_object()?;
    Some((
        target.get("floor_id")?.as_str()?,
        target.get("x")?.as_u64()?,
        target.get("y")?.as_u64()?,
    ))
}

fn transition_is_pure(block: &SolverBlock) -> bool {
    block.kind == "transition"
        && block.data.get("initial_active").and_then(Value::as_bool) != Some(false)
        && block.data.as_object().is_some_and(|data| {
            data.keys().all(|key| {
                matches!(
                    key.as_str(),
                    "block_id"
                        | "floor_id"
                        | "initial_active"
                        | "kind"
                        | "numeric_id"
                        | "target"
                        | "x"
                        | "y"
                )
            })
        })
}

fn reversible_transition_candidates(index: usize, blocks: &[SolverBlock]) -> Vec<usize> {
    let Some(block) = blocks.get(index) else {
        return Vec::new();
    };
    if !transition_is_pure(block) {
        return Vec::new();
    }
    let Some((target_floor, target_x, target_y)) = transition_target(block) else {
        return Vec::new();
    };
    blocks
        .iter()
        .enumerate()
        .filter(|(candidate_index, candidate)| {
            *candidate_index != index
                && transition_is_pure(candidate)
                && candidate.floor == target_floor
                && candidate.x.abs_diff(target_x) + candidate.y.abs_diff(target_y) <= 1
                && transition_target(candidate).is_some_and(|(floor, x, y)| {
                    floor == block.floor && block.x.abs_diff(x) + block.y.abs_diff(y) <= 1
                })
        })
        .map(|(candidate_index, _)| candidate_index)
        .collect()
}

fn reversible_transition_partner(index: usize, blocks: &[SolverBlock]) -> Option<usize> {
    let partners = reversible_transition_candidates(index, blocks);
    if partners.len() != 1 {
        return None;
    }
    let partner = partners[0];
    let reverse = reversible_transition_candidates(partner, blocks);
    (reverse.len() == 1 && reverse[0] == index).then_some(partner)
}

impl ConnectivityIndex {
    fn new(floors: &HashMap<String, SolverFloor>, blocks: &[SolverBlock]) -> Self {
        let floors = floors
            .iter()
            .map(|(id, floor)| {
                let width = usize::try_from(floor.width).unwrap_or(0);
                let height = usize::try_from(floor.height).unwrap_or(0);
                let cell_count = width.saturating_mul(height);
                let mut cells = vec![false; cell_count];
                for &(x, y) in &floor.cells {
                    if let (Ok(x), Ok(y)) = (usize::try_from(x), usize::try_from(y)) {
                        if x < width && y < height {
                            cells[y * width + x] = true;
                        }
                    }
                }
                let mut blocks_by_cell = vec![Vec::new(); cell_count];
                for &index in &floor.blocks {
                    let block = &blocks[index];
                    if let (Ok(x), Ok(y)) = (usize::try_from(block.x), usize::try_from(block.y)) {
                        if x < width && y < height {
                            blocks_by_cell[y * width + x].push(index);
                        }
                    }
                }
                (
                    id.clone(),
                    ConnectivityFloor {
                        width,
                        height,
                        cells,
                        blocks_by_cell,
                    },
                )
            })
            .collect();
        let reversible = (0..blocks.len())
            .map(|index| reversible_transition_partner(index, blocks))
            .collect();
        Self { floors, reversible }
    }

    fn local_reachable(
        &self,
        state: &SolverState,
        floor_id: &str,
        start: (u64, u64),
        blocks: &[SolverBlock],
    ) -> (Vec<bool>, Option<usize>) {
        let Some(floor) = self.floors.get(floor_id) else {
            return (Vec::new(), None);
        };
        let (Ok(start_x), Ok(start_y)) = (usize::try_from(start.0), usize::try_from(start.1))
        else {
            return (Vec::new(), None);
        };
        if start_x >= floor.width || start_y >= floor.height {
            return (Vec::new(), None);
        }
        let start_index = start_y * floor.width + start_x;
        if !floor.cells.get(start_index).copied().unwrap_or(false) {
            return (Vec::new(), None);
        }
        let mut seen = vec![false; floor.cells.len()];
        seen[start_index] = true;
        let mut queue = VecDeque::from([start_index]);
        let mut representative = start_index;
        while let Some(position) = queue.pop_front() {
            representative = representative.min(position);
            let x = position % floor.width;
            let y = position / floor.width;
            for (dx, dy) in [(0_i64, -1_i64), (-1, 0), (1, 0), (0, 1)] {
                let nx = x as i64 + dx;
                let ny = y as i64 + dy;
                if nx < 0 || ny < 0 {
                    continue;
                }
                let (nx, ny) = (nx as usize, ny as usize);
                if nx >= floor.width || ny >= floor.height {
                    continue;
                }
                let next = ny * floor.width + nx;
                if seen[next] || !floor.cells[next] {
                    continue;
                }
                let blocked = floor.blocks_by_cell[next].iter().any(|&index| {
                    let block = &blocks[index];
                    !block_is_consumed(state, block)
                        && block.kind != "terrain"
                        && block.kind != "shop"
                });
                if !blocked {
                    seen[next] = true;
                    queue.push_back(next);
                }
            }
        }
        (seen, Some(representative))
    }

    fn adjacent_position(
        floor: &ConnectivityFloor,
        reachable: &[bool],
        x: u64,
        y: u64,
    ) -> Option<(u64, u64)> {
        [(0_i64, -1_i64), (-1, 0), (1, 0), (0, 1)]
            .into_iter()
            .filter_map(|(dx, dy)| {
                let nx = i64::try_from(x).ok()?.checked_add(dx)?;
                let ny = i64::try_from(y).ok()?.checked_add(dy)?;
                let (nx, ny) = (usize::try_from(nx).ok()?, usize::try_from(ny).ok()?);
                (nx < floor.width
                    && ny < floor.height
                    && reachable
                        .get(ny * floor.width + nx)
                        .copied()
                        .unwrap_or(false))
                .then_some((nx as u64, ny as u64))
            })
            .min()
    }

    fn view(
        &self,
        state: &SolverState,
        floors: &HashMap<String, SolverFloor>,
        blocks: &[SolverBlock],
        terminals: &[(&str, (u64, u64))],
        record_navigation: bool,
    ) -> ConnectivityView {
        let mut queue = VecDeque::from([(state.floor.clone(), (state.x, state.y), Vec::new())]);
        let mut components = HashSet::<(String, usize)>::new();
        let mut boundary_seen = HashSet::new();
        let mut boundaries = Vec::new();
        let mut shops = HashMap::new();
        let mut terminal_seen = HashSet::new();
        let mut reachable_terminals = Vec::new();
        let mut representative = (state.floor.clone(), state.x, state.y);
        while let Some((floor_id, entry, navigation)) = queue.pop_front() {
            let (reachable, Some(local_representative)) =
                self.local_reachable(state, &floor_id, entry, blocks)
            else {
                continue;
            };
            if !components.insert((floor_id.clone(), local_representative)) {
                continue;
            }
            let Some(indexed_floor) = self.floors.get(&floor_id) else {
                continue;
            };
            let local_position = (
                (local_representative % indexed_floor.width) as u64,
                (local_representative / indexed_floor.width) as u64,
            );
            representative =
                representative.min((floor_id.clone(), local_position.0, local_position.1));
            for &(candidate_floor, position) in terminals {
                if candidate_floor != floor_id {
                    continue;
                }
                let (Ok(x), Ok(y)) = (usize::try_from(position.0), usize::try_from(position.1))
                else {
                    continue;
                };
                if x < indexed_floor.width
                    && y < indexed_floor.height
                    && reachable[y * indexed_floor.width + x]
                    && terminal_seen.insert((floor_id.clone(), position))
                {
                    reachable_terminals.push(ReachTerminal {
                        floor: floor_id.clone(),
                        position,
                        navigation: navigation.clone(),
                    });
                }
            }
            for &index in floors
                .get(&floor_id)
                .into_iter()
                .flat_map(|floor| &floor.blocks)
            {
                let block = &blocks[index];
                if block_is_consumed(state, block)
                    || block.kind == "opaque"
                    || block.kind == "terrain"
                {
                    continue;
                }
                let Some(adjacent) =
                    Self::adjacent_position(indexed_floor, &reachable, block.x, block.y)
                else {
                    continue;
                };
                if block.kind == "transition" && self.reversible[index].is_some() {
                    if let Some((target_floor, target_x, target_y)) = transition_target(block) {
                        let next_navigation = if record_navigation {
                            let mut next = navigation.clone();
                            next.push(index);
                            next
                        } else {
                            Vec::new()
                        };
                        queue.push_back((
                            target_floor.to_owned(),
                            (target_x, target_y),
                            next_navigation,
                        ));
                    }
                    continue;
                }
                if block.kind == "shop" {
                    if let Some(shop_id) = block.data.get("shop_id").and_then(Value::as_str) {
                        shops
                            .entry(shop_id.to_owned())
                            .or_insert_with(|| (floor_id.clone(), adjacent, navigation.clone()));
                    }
                    continue;
                }
                if boundary_seen.insert(index) {
                    boundaries.push(ReachBoundary {
                        index,
                        adjacent,
                        navigation: navigation.clone(),
                    });
                }
            }
        }
        reachable_terminals.sort_by(|left, right| {
            left.floor
                .cmp(&right.floor)
                .then_with(|| left.position.0.cmp(&right.position.0))
                .then_with(|| left.position.1.cmp(&right.position.1))
                .then_with(|| left.navigation.cmp(&right.navigation))
        });
        ConnectivityView {
            representative,
            boundaries,
            shops,
            terminals: reachable_terminals,
        }
    }
}

fn add_delta(state: &mut SolverState, delta: &Value) -> Result<(), String> {
    let delta = delta
        .as_object()
        .ok_or_else(|| "resource_delta_invalid".to_owned())?;
    for (name, target) in [
        ("gold", &mut state.gold),
        ("experience", &mut state.experience),
    ] {
        *target = target
            .checked_add(delta.get(name).and_then(Value::as_u64).unwrap_or(0))
            .ok_or_else(|| "stat_overflow".to_owned())?;
    }
    for (name, target) in [
        ("hp", &mut state.hp),
        ("attack", &mut state.attack),
        ("defense", &mut state.defense),
    ] {
        *target = target
            .add(delta.get(name).and_then(Value::as_f64).unwrap_or(0.0))
            .ok_or_else(|| "stat_overflow".to_owned())?;
    }
    state.level = state
        .level
        .checked_add(delta.get("level").and_then(Value::as_u64).unwrap_or(0))
        .ok_or_else(|| "stat_overflow".to_owned())?;
    if let Some(multiply) = delta.get("multiply").and_then(Value::as_object) {
        for (name, target) in [
            ("hp", &mut state.hp),
            ("attack", &mut state.attack),
            ("defense", &mut state.defense),
        ] {
            *target = target
                .mul(multiply.get(name).and_then(Value::as_f64).unwrap_or(1.0))
                .ok_or_else(|| "stat_overflow".to_owned())?;
        }
    }
    if let Some(keys) = delta.get("keys").and_then(Value::as_object) {
        state.yellow += keys.get("yellow").and_then(Value::as_u64).unwrap_or(0);
        state.blue += keys.get("blue").and_then(Value::as_u64).unwrap_or(0);
        state.red += keys.get("red").and_then(Value::as_u64).unwrap_or(0);
    }
    let mut inventory: BTreeMap<String, u64> = state.inventory.iter().cloned().collect();
    if let Some(items) = delta.get("inventory").and_then(Value::as_object) {
        for (id, count) in items {
            *inventory.entry(id.clone()).or_default() += count.as_u64().unwrap_or(0);
        }
    }
    state.inventory = Arc::new(inventory.into_iter().collect());
    Ok(())
}

fn enemy_loss(state: &SolverState, enemy: &Value) -> Option<f64> {
    let enemy = enemy.as_object()?;
    let hp = enemy.get("hp")?.as_u64()?;
    let attack = enemy.get("attack")?.as_u64()?;
    let defense = enemy.get("defense")?.as_u64()?;
    let hero_damage = state.attack.get() - defense as f64;
    if hero_damage <= 0.0 {
        return None;
    }
    let rounds = (hp as f64 / hero_damage).ceil();
    Some((rounds - 1.0).max(0.0) * (attack as f64 - state.defense.get()).max(0.0))
}

fn state_count(entries: &[(String, u64)], id: &str) -> u64 {
    entries
        .iter()
        .find(|(name, _)| name == id)
        .map(|(_, value)| *value)
        .unwrap_or(0)
}

fn state_set(entries: &mut Arc<Vec<(String, u64)>>, id: &str, value: u64) {
    let mut map: BTreeMap<String, u64> = entries.iter().cloned().collect();
    if value == 0 {
        map.remove(id);
    } else {
        map.insert(id.to_owned(), value);
    }
    *entries = Arc::new(map.into_iter().collect());
}

fn block_is_consumed(state: &SolverState, block: &SolverBlock) -> bool {
    block
        .state_slot
        .and_then(|slot| state.consumed.read(slot))
        .unwrap_or(false)
}

fn initial_consumed_bits(blocks: &[SolverBlock], bit_len: usize) -> Result<ConsumedBits, ()> {
    let mut consumed = ConsumedBits::new(bit_len);
    let changes: Option<Vec<_>> = blocks
        .iter()
        .filter(|block| block.data.get("initial_active").and_then(Value::as_bool) == Some(false))
        .map(|block| block.state_slot.map(|slot| (slot, true)))
        .collect();
    consumed.set_many(&changes.ok_or(())?)?;
    Ok(consumed)
}

fn set_block_consumed(state: &mut SolverState, block: &SolverBlock, value: bool) -> bool {
    let Some(slot) = block.state_slot else {
        return false;
    };
    state.consumed.set(slot, value).is_ok()
}

fn set_at(
    state: &mut SolverState,
    blocks: &[SolverBlock],
    floor: &str,
    x: u64,
    y: u64,
    value: bool,
) -> bool {
    let targets: Vec<_> = blocks
        .iter()
        .filter(|block| block.floor == floor && block.x == x && block.y == y)
        .collect();
    let changes: Option<Vec<_>> = targets
        .iter()
        .map(|block| block.state_slot.map(|slot| (slot, value)))
        .collect();
    let Some(changes) = changes else {
        return false;
    };
    !targets.is_empty() && state.consumed.set_many(&changes).is_ok()
}

fn consume_at(
    state: &mut SolverState,
    blocks: &[SolverBlock],
    floor: &str,
    x: u64,
    y: u64,
) -> bool {
    set_at(state, blocks, floor, x, y, true)
}

fn activate_at(
    state: &mut SolverState,
    blocks: &[SolverBlock],
    floor: &str,
    x: u64,
    y: u64,
) -> bool {
    set_at(state, blocks, floor, x, y, false)
}

fn replace_at(
    state: &mut SolverState,
    blocks: &[SolverBlock],
    floor: &str,
    x: u64,
    y: u64,
    numeric_id: u64,
) -> bool {
    let targets: Vec<_> = blocks
        .iter()
        .filter(|block| block.floor == floor && block.x == x && block.y == y)
        .collect();
    let replacement = targets
        .iter()
        .find(|block| block.data.get("numeric_id").and_then(Value::as_u64) == Some(numeric_id));
    let changes: Option<Vec<_>> = targets
        .iter()
        .map(|block| block.state_slot.map(|slot| (slot, true)))
        .chain(std::iter::once(
            replacement.and_then(|block| block.state_slot.map(|slot| (slot, false))),
        ))
        .collect();
    !targets.is_empty()
        && changes
            .as_deref()
            .is_some_and(|changes| state.consumed.set_many(changes).is_ok())
}

fn apply_audited_event(
    state: &mut SolverState,
    block: &SolverBlock,
    _block_index: usize,
    blocks: &[SolverBlock],
) -> Option<Value> {
    let id = block.data.get("event")?.get("id")?.as_str()?;
    let add_item = |state: &mut SolverState, name: &str, amount: u64| {
        let old = state_count(&state.inventory, name);
        state_set(&mut state.inventory, name, old.saturating_add(amount));
    };
    let consume_item = |state: &mut SolverState, name: &str, amount: u64| -> bool {
        let old = state_count(&state.inventory, name);
        if old < amount {
            return false;
        }
        state_set(&mut state.inventory, name, old - amount);
        true
    };
    match id {
        "fairy_mt0" => {
            if state_count(&state.flags, "16") == 1 {
                state_set(&mut state.flags, "16", 0);
                state_set(&mut state.flags, "22", 1);
            } else if consume_item(state, "cross", 1) {
                state.hp = state.hp.mul(4.0)?.div(3.0)?;
                state.attack = state.attack.mul(4.0)?.div(3.0)?;
                state.defense = state.defense.mul(4.0)?.div(3.0)?;
                if !set_block_consumed(state, block, true)
                    || !activate_at(state, blocks, "MT20", 6, 8)
                {
                    return None;
                }
            } else {
                return None;
            }
        }
        "book_reward" => {
            add_item(state, "book", 1);
            set_block_consumed(state, block, true).then_some(())?;
        }
        "sword2_reward" => {
            state.attack = state.attack.add(70.0)?;
            set_block_consumed(state, block, true).then_some(())?;
        }
        "shield2_reward" => {
            state.defense = state.defense.add(30.0)?;
            set_block_consumed(state, block, true).then_some(())?;
        }
        "cross_reward" => {
            add_item(state, "cross", 1);
            if !set_block_consumed(state, block, true) || !consume_at(state, blocks, "MT16", 5, 5) {
                return None;
            }
        }
        "fly_reward" => {
            add_item(state, "fly", 1);
            state_set(&mut state.flags, "fly", 1);
            set_block_consumed(state, block, true).then_some(())?;
        }
        "ice_pickaxe_reward" => {
            add_item(state, "icePickaxe", 1);
            set_block_consumed(state, block, true).then_some(())?;
        }
        "exp_sword_trade" => {
            if state.experience < 500 {
                return None;
            }
            state.experience -= 500;
            state.attack = state.attack.add(120.0)?;
            set_block_consumed(state, block, true).then_some(())?;
        }
        "gold_shield_trade" => {
            if state.gold < 500 {
                return None;
            }
            state.gold -= 500;
            state.defense = state.defense.add(120.0)?;
            set_block_consumed(state, block, true).then_some(())?;
        }
        "ice_wand_reward" => {
            state_set(&mut state.flags, "16", 1);
            set_block_consumed(state, block, true).then_some(())?;
        }
        "dialogue_once" => {
            set_block_consumed(state, block, true).then_some(())?;
        }
        "thief_quest" => {
            if state_count(&state.flags, "switch:MT4:6,1:A") == 0 {
                state_set(&mut state.flags, "switch:MT4:6,1:A", 1);
                consume_at(state, blocks, "MT2", 2, 7).then_some(())?;
            } else if consume_item(state, "icePickaxe", 1) {
                if !consume_at(state, blocks, "MT18", 6, 9)
                    || !consume_at(state, blocks, "MT18", 6, 10)
                    || !set_block_consumed(state, block, true)
                {
                    return None;
                }
            } else {
                return None;
            }
        }
        "princess_quest" => {
            if state_count(&state.flags, "switch:MT18:6,5:A") > 0 {
                return None;
            }
            state_set(&mut state.flags, "switch:MT18:6,5:A", 1);
            activate_at(state, blocks, "MT18", 11, 11).then_some(())?;
        }
        "wand_gate_remove_on_failure" | "wand_gate_retry" => {
            let missing = blocks.iter().any(|candidate| {
                ((candidate.floor == "MT23w" && candidate.x == 5 && candidate.y == 6)
                    || (candidate.floor == "MT23e" && candidate.x == 7 && candidate.y == 6))
                    && !block_is_consumed(state, candidate)
            });
            if missing {
                if id == "wand_gate_remove_on_failure" {
                    set_block_consumed(state, block, true).then_some(())?;
                } else {
                    return None;
                }
            } else {
                state_set(&mut state.flags, "final_wand_gate", 1);
                set_block_consumed(state, block, true).then_some(())?;
                for (x, y, numeric_id) in [
                    (5, 2, 181),
                    (6, 2, 182),
                    (7, 2, 183),
                    (5, 3, 184),
                    (6, 3, 185),
                    (7, 3, 186),
                    (5, 4, 187),
                    (6, 4, 258),
                    (7, 4, 188),
                ] {
                    if !replace_at(state, blocks, "MT_1", x, y, numeric_id) {
                        return None;
                    }
                }
            }
        }
        _ => return None,
    }
    Some(json!({"event_id":id}))
}

struct MaterializedCandidate {
    state: SolverState,
    route_action: Option<RouteAction>,
}

fn materialize_pending_action(
    source: &SolverState,
    pending_action: PendingAction,
    blocks: &[SolverBlock],
    shops: &[Value],
    record_route: bool,
) -> Option<MaterializedCandidate> {
    let mut next = MaterializedCandidate {
        state: source.clone(),
        route_action: None,
    };
    match pending_action {
        PendingAction::Block { index, adjacent } => {
            let block = blocks.get(index)?;
            next.state.floor = block.floor.clone();
            (next.state.x, next.state.y) = adjacent;
            match block.kind.as_str() {
                "door" => {
                    let cost = &block.data["key_cost"];
                    let (yellow, blue, red) = (
                        cost["yellow"].as_u64().unwrap_or(0),
                        cost["blue"].as_u64().unwrap_or(0),
                        cost["red"].as_u64().unwrap_or(0),
                    );
                    if next.state.yellow < yellow || next.state.blue < blue || next.state.red < red
                    {
                        return None;
                    }
                    let mut inventory: BTreeMap<String, u64> =
                        next.state.inventory.iter().cloned().collect();
                    let inventory_cost =
                        block.data.get("inventory_cost").and_then(Value::as_object);
                    if inventory_cost.is_some_and(|costs| {
                        costs.iter().any(|(id, count)| {
                            inventory.get(id).copied().unwrap_or(0)
                                < count.as_u64().unwrap_or(u64::MAX)
                        })
                    }) {
                        return None;
                    }
                    next.state.yellow -= yellow;
                    next.state.blue -= blue;
                    next.state.red -= red;
                    if let Some(costs) = inventory_cost {
                        for (id, count) in costs {
                            *inventory.entry(id.clone()).or_default() -= count.as_u64()?;
                        }
                    }
                    next.state.inventory = Arc::new(
                        inventory
                            .into_iter()
                            .filter(|(_, count)| *count > 0)
                            .collect(),
                    );
                    if !set_block_consumed(&mut next.state, block, true) {
                        return None;
                    }
                    if record_route {
                        next.route_action = Some(RouteAction::Block {
                            index,
                            action: BlockRouteAction::Door { yellow, blue, red },
                        });
                    }
                }
                "resource" => {
                    add_delta(&mut next.state, &block.data["delta"]).ok()?;
                    if !set_block_consumed(&mut next.state, block, true) {
                        return None;
                    }
                    if record_route {
                        next.route_action = Some(RouteAction::Block {
                            index,
                            action: BlockRouteAction::Resource,
                        });
                    }
                }
                "enemy" => {
                    let loss = enemy_loss(&next.state, &block.data["enemy"])?;
                    if loss >= next.state.hp.get() {
                        return None;
                    }
                    next.state.hp = F64Bits::new(next.state.hp.get() - loss)?;
                    next.state.gold += block.data["enemy"]["gold"].as_u64().unwrap_or(0);
                    next.state.experience +=
                        block.data["enemy"]["experience"].as_u64().unwrap_or(0);
                    if !set_block_consumed(&mut next.state, block, true) {
                        return None;
                    }
                    if record_route {
                        next.route_action = Some(RouteAction::Block {
                            index,
                            action: BlockRouteAction::Enemy {
                                hp_loss: F64Bits::new(loss)?,
                            },
                        });
                    }
                }
                "transition" => {
                    let target = &block.data["target"];
                    next.state.floor = target["floor_id"].as_str().unwrap_or_default().to_owned();
                    next.state.x = target["x"].as_u64().unwrap_or(0);
                    next.state.y = target["y"].as_u64().unwrap_or(0);
                    if record_route {
                        next.route_action = Some(RouteAction::Block {
                            index,
                            action: BlockRouteAction::Transition,
                        });
                    }
                }
                "event" => {
                    let event_details = apply_audited_event(&mut next.state, block, index, blocks)?;
                    if record_route {
                        next.route_action = Some(RouteAction::Block {
                            index,
                            action: BlockRouteAction::Event {
                                event_id: event_details["event_id"]
                                    .as_str()
                                    .unwrap_or_default()
                                    .to_owned(),
                            },
                        });
                    }
                }
                _ => return None,
            }
        }
        PendingAction::Shop {
            shop_index,
            choice_index,
            choice_offset,
            floor,
            adjacent,
        } => {
            let shop = shops.get(shop_index)?;
            let shop_id = shop
                .get("shop_id")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let choice = shop.get("choices")?.as_array()?.get(choice_index)?;
            let count_index = choice_offset.checked_add(choice_index)?;
            let purchase_count = *next.state.shop_counts.get(count_index)?;
            let cost = choice["base_cost"].as_u64()?.checked_add(
                choice["increment_per_purchase"]
                    .as_u64()?
                    .checked_mul(purchase_count)?,
            )?;
            next.state.floor = floor.clone();
            (next.state.x, next.state.y) = adjacent;
            let currency = choice
                .get("currency")
                .and_then(Value::as_str)
                .unwrap_or("gold");
            let balance = match currency {
                "gold" => next.state.gold,
                "experience" => next.state.experience,
                "yellow" => next.state.yellow,
                "blue" => next.state.blue,
                "red" => next.state.red,
                _ => return None,
            };
            if balance < cost {
                return None;
            }
            match currency {
                "gold" => next.state.gold -= cost,
                "experience" => next.state.experience -= cost,
                "yellow" => next.state.yellow -= cost,
                "blue" => next.state.blue -= cost,
                "red" => next.state.red -= cost,
                _ => unreachable!(),
            }
            let effects: Vec<Value> = choice
                .get("effects")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_else(|| vec![choice["effect"].clone()]);
            for effect in &effects {
                let field = effect["field"].as_str().unwrap_or_default();
                let amount = effect["amount"].as_u64().unwrap_or(0);
                match field {
                    "level" => next.state.level = next.state.level.saturating_add(amount),
                    "hp" => next.state.hp = next.state.hp.add(amount as f64)?,
                    "attack" => next.state.attack = next.state.attack.add(amount as f64)?,
                    "defense" => next.state.defense = next.state.defense.add(amount as f64)?,
                    "gold" => next.state.gold = next.state.gold.saturating_add(amount),
                    "experience" => {
                        next.state.experience = next.state.experience.saturating_add(amount)
                    }
                    "yellow" => next.state.yellow = next.state.yellow.saturating_add(amount),
                    "blue" => next.state.blue = next.state.blue.saturating_add(amount),
                    "red" => next.state.red = next.state.red.saturating_add(amount),
                    _ => return None,
                }
            }
            Arc::make_mut(&mut next.state.shop_counts)[count_index] += 1;
            if record_route {
                next.route_action = Some(RouteAction::Shop {
                    floor,
                    shop_id: shop_id.to_owned(),
                    choice_id: choice["choice_id"].as_str().unwrap_or_default().to_owned(),
                    currency: currency.to_owned(),
                    cost,
                    purchase_count_before: purchase_count,
                    effects: effects
                        .iter()
                        .map(|effect| {
                            Some(ShopRouteEffect {
                                field: effect["field"].as_str().unwrap_or_default().to_owned(),
                                amount: effect["amount"].as_u64().unwrap_or(0),
                            })
                        })
                        .collect::<Option<Vec<_>>>()?,
                });
            }
        }
    }
    Some(next)
}

#[derive(Clone)]
struct RouteSegment {
    navigation: Vec<usize>,
    action: PendingAction,
}

struct Phase2Node {
    route_keys: Vec<RouteStepKey>,
    serial: usize,
    state: SolverState,
    steps: Vec<Value>,
    segments: Vec<RouteSegment>,
    // A witness is state-simple, matching Phase 1's exact-state search space.
    // This prevents a route prefix from reaching the same state as one of its
    // ancestors through a zero-state cycle.
    visited_states: Vec<SolverState>,
}

impl PartialEq for Phase2Node {
    fn eq(&self, other: &Self) -> bool {
        cmp_route_sequences(&self.route_keys, &other.route_keys).is_eq()
            && self.serial == other.serial
    }
}

impl Eq for Phase2Node {}

impl Ord for Phase2Node {
    fn cmp(&self, other: &Self) -> Ordering {
        other
            .route_keys
            .as_slice()
            .cmp_route_order(&self.route_keys)
            .then_with(|| other.serial.cmp(&self.serial))
    }
}

impl PartialOrd for Phase2Node {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

struct Phase2Route {
    state: SolverState,
    steps: Vec<Value>,
    segments: Vec<RouteSegment>,
    terminal_floor: String,
    terminal_pos: (u64, u64),
    terminal_navigation: Vec<usize>,
}

trait RouteSequenceOrder {
    fn cmp_route_order(&self, other: &[RouteStepKey]) -> Ordering;
}

impl RouteSequenceOrder for [RouteStepKey] {
    fn cmp_route_order(&self, other: &[RouteStepKey]) -> Ordering {
        cmp_route_sequences(self, other)
    }
}

// The public tie-break historically compared the JSON text for the complete
// array. Equal prefixes therefore have the intentionally unusual rule that a
// longer sequence sorts first: its next byte is ',' while the shorter array's
// next byte is ']'. Keep that protocol behavior explicit rather than silently
// replacing it with Rust's ordinary Vec lexicographic order.
fn cmp_route_sequences(left: &[RouteStepKey], right: &[RouteStepKey]) -> Ordering {
    for (left_step, right_step) in left.iter().zip(right) {
        let order = left_step.cmp(right_step);
        if !order.is_eq() {
            return order;
        }
    }
    right.len().cmp(&left.len())
}

fn append_navigation_steps(
    steps: &mut Vec<Value>,
    keys: &mut Vec<RouteStepKey>,
    navigation: &[usize],
    blocks: &[SolverBlock],
) {
    for index in navigation {
        let step = route_action_step(
            &RouteAction::Block {
                index: *index,
                action: BlockRouteAction::Transition,
            },
            blocks,
        );
        steps.push(step.value);
        keys.push(step.key);
    }
}

fn phase2_prefix_is_better(
    seen_prefix: &HashMap<SolverState, Vec<RouteStepKey>>,
    state: &SolverState,
    route_keys: &[RouteStepKey],
) -> bool {
    seen_prefix
        .get(state)
        .is_none_or(|existing| cmp_route_sequences(route_keys, existing).is_lt())
}

fn enqueue_phase2_action(
    queue: &mut BinaryHeap<Phase2Node>,
    serial: &mut usize,
    source: &Phase2Node,
    navigation: Vec<usize>,
    action: PendingAction,
    blocks: &[SolverBlock],
    shops: &[Value],
) {
    let Some(materialized) =
        materialize_pending_action(&source.state, action.clone(), blocks, shops, true)
    else {
        return;
    };
    let Some(route_action) = materialized.route_action else {
        return;
    };
    let mut steps = source.steps.clone();
    let mut route_keys = source.route_keys.clone();
    append_navigation_steps(&mut steps, &mut route_keys, &navigation, blocks);
    let route_step = route_action_step(&route_action, blocks);
    steps.push(route_step.value);
    route_keys.push(route_step.key);
    let mut segments = source.segments.clone();
    segments.push(RouteSegment { navigation, action });
    *serial = serial.saturating_add(1);
    queue.push(Phase2Node {
        route_keys,
        serial: *serial,
        state: materialized.state,
        steps,
        segments,
        visited_states: source.visited_states.clone(),
    });
}

fn replay_phase2_route(
    initial: &SolverState,
    route: &Phase2Route,
    blocks: &[SolverBlock],
    shops: &[Value],
) -> Option<SolverState> {
    let mut state = initial.clone();
    for segment in &route.segments {
        for &index in &segment.navigation {
            let transition = blocks.get(index)?;
            if transition.kind != "transition" || block_is_consumed(&state, transition) {
                return None;
            }
            let (floor, x, y) = transition_target(transition)?;
            state.floor = floor.to_owned();
            state.x = x;
            state.y = y;
        }
        state =
            materialize_pending_action(&state, segment.action.clone(), blocks, shops, false)?.state;
    }
    for &index in &route.terminal_navigation {
        let transition = blocks.get(index)?;
        if transition.kind != "transition" || block_is_consumed(&state, transition) {
            return None;
        }
        let (floor, x, y) = transition_target(transition)?;
        state.floor = floor.to_owned();
        state.x = x;
        state.y = y;
    }
    // Walking inside the reachable component is not a route step. The terminal
    // witness may therefore end at another free cell after its last transition.
    state.floor = route.terminal_floor.clone();
    (state.x, state.y) = route.terminal_pos;
    Some(state)
}

enum Phase2Outcome {
    Found { route: Phase2Route, explored: usize },
    BudgetExhausted { explored: usize },
    NoWitness { explored: usize },
}

fn extract_route_witness(
    initial: &SolverState,
    target: NumericObjective,
    max_states: usize,
    connectivity: &ConnectivityIndex,
    floors: &HashMap<String, SolverFloor>,
    blocks: &[SolverBlock],
    terminals: &[(&str, (u64, u64))],
    shops: &[Value],
) -> Phase2Outcome {
    #[cfg(test)]
    {
        PHASE2_CALLS.with(|calls| calls.set(calls.get() + 1));
        PHASE2_SAW_PHASE_A_DROPPED
            .with(|seen| PHASE_A_DROPPED.with(|dropped| seen.set(dropped.get())));
    }
    let mut queue = BinaryHeap::new();
    queue.push(Phase2Node {
        route_keys: Vec::new(),
        serial: 0,
        state: initial.clone(),
        steps: Vec::new(),
        segments: Vec::new(),
        visited_states: Vec::new(),
    });
    let mut serial = 0usize;
    let mut seen_prefix = HashMap::<SolverState, Vec<RouteStepKey>>::new();
    let mut explored = 0usize;
    let mut best: Option<(Vec<RouteStepKey>, Phase2Route)> = None;
    while let Some(mut node) = queue.pop() {
        if explored >= max_states {
            return Phase2Outcome::BudgetExhausted { explored };
        }
        let view = connectivity.view(&node.state, floors, blocks, terminals, true);
        (node.state.floor, node.state.x, node.state.y) = view.representative.clone();
        if node.visited_states.iter().any(|old| old == &node.state) {
            continue;
        }
        if !phase2_prefix_is_better(&seen_prefix, &node.state, &node.route_keys) {
            continue;
        }
        seen_prefix.insert(node.state.clone(), node.route_keys.clone());
        node.visited_states.push(node.state.clone());
        explored += 1;
        for terminal in &view.terminals {
            if NumericObjective::from_state(&node.state).matches(target) {
                let mut steps = node.steps.clone();
                let mut route_keys = node.route_keys.clone();
                append_navigation_steps(&mut steps, &mut route_keys, &terminal.navigation, blocks);
                let terminal_step = RouteStep::new(RouteStepSemantic::Terminal {
                    floor_id: terminal.floor.clone(),
                    x: terminal.position.0,
                    y: terminal.position.1,
                });
                steps.push(terminal_step.value);
                route_keys.push(terminal_step.key);
                let candidate = Phase2Route {
                    state: node.state.clone(),
                    steps,
                    segments: node.segments.clone(),
                    terminal_floor: terminal.floor.clone(),
                    terminal_pos: terminal.position,
                    terminal_navigation: terminal.navigation.clone(),
                };
                if replay_phase2_route(initial, &candidate, blocks, shops)
                    .is_some_and(|replayed| NumericObjective::from_state(&replayed).matches(target))
                    && best
                        .as_ref()
                        .is_none_or(|(old, _)| cmp_route_sequences(&route_keys, old).is_lt())
                {
                    best = Some((route_keys, candidate));
                }
            }
        }
        for boundary in view.boundaries {
            enqueue_phase2_action(
                &mut queue,
                &mut serial,
                &node,
                boundary.navigation,
                PendingAction::Block {
                    index: boundary.index,
                    adjacent: boundary.adjacent,
                },
                blocks,
                shops,
            );
        }
        let mut choice_offset = 0usize;
        for (shop_index, shop) in shops.iter().enumerate() {
            let shop_id = shop
                .get("shop_id")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let choices = shop
                .get("choices")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            if let Some((floor, adjacent, navigation)) = view.shops.get(shop_id) {
                for choice_index in 0..choices.len() {
                    enqueue_phase2_action(
                        &mut queue,
                        &mut serial,
                        &node,
                        navigation.clone(),
                        PendingAction::Shop {
                            shop_index,
                            choice_index,
                            choice_offset,
                            floor: floor.clone(),
                            adjacent: *adjacent,
                        },
                        blocks,
                        shops,
                    );
                }
            }
            choice_offset += choices.len();
        }
    }
    best.map_or(Phase2Outcome::NoWitness { explored }, |(_, route)| {
        Phase2Outcome::Found { route, explored }
    })
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct TwoPhaseStats {
    phase_a_explored: usize,
    phase_b_explored: usize,
}

enum PhaseAOutcome {
    BudgetExhausted,
    Complete(Option<NumericObjective>),
}

struct PhaseAResult {
    outcome: PhaseAOutcome,
    explored: usize,
}

#[cfg(test)]
struct PhaseADropProbe;

#[cfg(test)]
impl Drop for PhaseADropProbe {
    fn drop(&mut self) {
        PHASE_A_DROPPED.with(|dropped| dropped.set(true));
    }
}

// Keep the proof search in a separate function rather than merely relying on
// non-lexical lifetimes. Its queue, state arena, exact seen set, dominance
// frontier, and all connectivity views are unconditionally dropped before a
// caller can enter Phase 2. The result deliberately carries only a scalar
// objective/status and count; it cannot retain a Phase A arena through Arc.
fn run_numeric_proof(
    initial: &SolverState,
    max_states: usize,
    connectivity: &ConnectivityIndex,
    floors: &HashMap<String, SolverFloor>,
    blocks: &[SolverBlock],
    terminals: &[(&str, (u64, u64))],
    shops: &[Value],
) -> PhaseAResult {
    #[cfg(test)]
    let _drop_probe = PhaseADropProbe;
    let mut initial_node = Some(initial.clone());
    let mut queue: VecDeque<PendingCandidate> = VecDeque::new();
    let mut state_arena = Vec::new();
    let mut seen = HashSet::new();
    let mut dominance: HashMap<StructuralKey, Vec<[f64; 8]>> = HashMap::new();
    let mut explored = 0usize;
    let mut best: Option<NumericObjective> = None;
    loop {
        let mut next_node = initial_node.take();
        while next_node.is_none() {
            let Some(candidate) = queue.pop_front() else {
                break;
            };
            let source = state_arena
                .get(candidate.source)
                .expect("pending candidate source must be an accepted state");
            next_node = materialize_pending_action(source, candidate.action, blocks, shops, false)
                .map(|candidate| candidate.state);
        }
        let Some(mut node) = next_node else {
            break;
        };
        if explored >= max_states {
            return PhaseAResult {
                outcome: PhaseAOutcome::BudgetExhausted,
                explored,
            };
        }
        let view = connectivity.view(&node, floors, blocks, terminals, false);
        (node.floor, node.x, node.y) = view.representative.clone();
        if !seen.insert(node.clone()) {
            continue;
        }
        let structural = StructuralKey::from(&node);
        let resources = [
            node.hp.get(),
            node.attack.get(),
            node.defense.get(),
            node.gold as f64,
            node.experience as f64,
            node.yellow as f64,
            node.blue as f64,
            node.red as f64,
        ];
        let frontier = dominance.entry(structural).or_default();
        if frontier.iter().any(|old| {
            old.iter()
                .zip(resources)
                .all(|(left, right)| *left >= right)
        }) {
            continue;
        }
        frontier.retain(|old| {
            !resources
                .iter()
                .zip(old)
                .all(|(left, right)| *left >= *right)
        });
        frontier.push(resources);
        explored += 1;
        let state_index = state_arena.len();
        state_arena.push(node.clone());
        if !view.terminals.is_empty() {
            let objective = NumericObjective::from_state(&node);
            if best.is_none_or(|old| objective.cmp(old).is_gt()) {
                best = Some(objective);
            }
        }
        for boundary in view.boundaries {
            queue.push_back(PendingCandidate {
                source: state_index,
                action: PendingAction::Block {
                    index: boundary.index,
                    adjacent: boundary.adjacent,
                },
            });
        }
        let mut choice_offset = 0usize;
        for (shop_index, shop) in shops.iter().enumerate() {
            let shop_id = shop
                .get("shop_id")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let accessible = view.shops.get(shop_id);
            let choices = shop
                .get("choices")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            if let Some((shop_floor, adjacent, _navigation)) = accessible {
                for local in 0..choices.len() {
                    queue.push_back(PendingCandidate {
                        source: state_index,
                        action: PendingAction::Shop {
                            shop_index,
                            choice_index: local,
                            choice_offset,
                            floor: shop_floor.clone(),
                            adjacent: *adjacent,
                        },
                    });
                }
            }
            choice_offset += choices.len();
        }
    }
    PhaseAResult {
        outcome: PhaseAOutcome::Complete(best),
        explored,
    }
}

fn global_analysis(observation: &serde_json::Map<String, Value>) -> Value {
    global_analysis_with_stats(observation).0
}

fn global_analysis_with_stats(
    observation: &serde_json::Map<String, Value>,
) -> (Value, TwoPhaseStats) {
    let source_blockers = observation
        .get("engine_model")
        .and_then(Value::as_object)
        .and_then(|model| model.get("solver_model"))
        .and_then(Value::as_object)
        .and_then(|model| model.get("blockers"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let parsed = parse_solver_world(observation);
    let Ok((floors, blocks, state_slot_count, terminal, shops, blockers)) = parsed else {
        return (
            json!({"scope":"global_terminal_route","proof":"unsupported","reason":parsed.unwrap_err(),
            "truncated":false,"explored_states":0,"blockers":source_blockers,"route":null,"first_suggestion":null}),
            TwoPhaseStats::default(),
        );
    };
    if !blockers.is_empty() {
        return (
            json!({"scope":"global_terminal_route","proof":"unsupported","reason":"unsupported_solver_blocker",
            "truncated":false,"explored_states":0,"blockers":blockers,"route":null,"first_suggestion":null}),
            TwoPhaseStats::default(),
        );
    }
    let connectivity = ConnectivityIndex::new(&floors, &blocks);
    let hero = observation.get("hero").and_then(Value::as_object).unwrap();
    let loc = hero.get("loc").and_then(Value::as_object).unwrap();
    let keys = observation.get("keys").and_then(Value::as_object).unwrap();
    let inventory = observation
        .get("engine_model")
        .and_then(Value::as_object)
        .and_then(|m| m.get("inventory"))
        .and_then(Value::as_object)
        .and_then(|i| i.get("classes"))
        .and_then(Value::as_object)
        .map(|classes| {
            classes
                .values()
                .filter_map(Value::as_object)
                .flat_map(|items| items.iter())
                .filter_map(|(id, count)| count.as_u64().map(|count| (id.clone(), count)))
                .collect()
        })
        .unwrap_or_default();
    let initial = SolverState {
        floor: observation
            .get("floor_id")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned(),
        x: loc.get("x").and_then(Value::as_u64).unwrap_or(0),
        y: loc.get("y").and_then(Value::as_u64).unwrap_or(0),
        hp: F64Bits::new(hero.get("hp").and_then(Value::as_f64).unwrap_or(0.0)).unwrap(),
        attack: F64Bits::new(hero.get("attack").and_then(Value::as_f64).unwrap_or(0.0)).unwrap(),
        defense: F64Bits::new(hero.get("defense").and_then(Value::as_f64).unwrap_or(0.0)).unwrap(),
        level: observation
            .get("engine_model")
            .and_then(Value::as_object)
            .and_then(|m| m.get("solver_model"))
            .and_then(Value::as_object)
            .and_then(|m| m.get("initial"))
            .and_then(Value::as_object)
            .and_then(|i| i.get("level"))
            .and_then(Value::as_u64)
            .unwrap_or(0),
        gold: hero.get("gold").and_then(Value::as_u64).unwrap_or(0),
        experience: hero.get("experience").and_then(Value::as_u64).unwrap_or(0),
        yellow: keys.get("yellow").and_then(Value::as_u64).unwrap_or(0),
        blue: keys.get("blue").and_then(Value::as_u64).unwrap_or(0),
        red: keys.get("red").and_then(Value::as_u64).unwrap_or(0),
        inventory: Arc::new(inventory),
        consumed: match initial_consumed_bits(&blocks, state_slot_count) {
            Ok(consumed) => consumed,
            Err(()) => {
                return (
                    json!({"scope":"global_terminal_route","proof":"unsupported",
                "reason":"state_slot_invalid","truncated":false,"explored_states":0,
                "blockers":source_blockers,"route":null,"first_suggestion":null}),
                    TwoPhaseStats::default(),
                );
            }
        },
        shop_counts: Arc::new(
            shops
                .iter()
                .flat_map(|shop| {
                    shop.get("choices")
                        .and_then(Value::as_array)
                        .into_iter()
                        .flatten()
                })
                .map(|choice| {
                    choice
                        .get("purchase_count")
                        .and_then(Value::as_u64)
                        .unwrap_or(0)
                })
                .collect(),
        ),
        flags: Arc::new(
            observation
                .get("engine_model")
                .and_then(Value::as_object)
                .and_then(|m| m.get("solver_model"))
                .and_then(Value::as_object)
                .and_then(|m| m.get("initial"))
                .and_then(Value::as_object)
                .and_then(|i| i.get("flags"))
                .and_then(Value::as_object)
                .map(|flags| {
                    flags
                        .iter()
                        .filter_map(|(name, value)| {
                            let number =
                                value.as_u64().or_else(|| value.as_bool().map(u64::from))?;
                            Some((name.clone(), number))
                        })
                        .collect()
                })
                .unwrap_or_default(),
        ),
    };
    let terminal_object = terminal.as_object().unwrap();
    let terminal_values: Vec<&Value> =
        if terminal_object.get("kind").and_then(Value::as_str) == Some("any_location") {
            terminal_object
                .get("locations")
                .and_then(Value::as_array)
                .map(|items| items.iter().collect())
                .unwrap_or_default()
        } else {
            vec![&terminal]
        };
    let terminals: Vec<(&str, (u64, u64))> = terminal_values
        .iter()
        .filter_map(|value| {
            let object = value.as_object()?;
            Some((
                object.get("floor_id")?.as_str()?,
                (object.get("x")?.as_u64()?, object.get("y")?.as_u64()?),
            ))
        })
        .collect();
    let max_states = observation
        .get("engine_model")
        .and_then(Value::as_object)
        .and_then(|m| m.get("solver_model"))
        .and_then(Value::as_object)
        .and_then(|m| m.get("search_budget"))
        .and_then(Value::as_u64)
        .map(|value| value.clamp(1, MAX_GLOBAL_STATES as u64) as usize)
        .unwrap_or(MAX_GLOBAL_STATES);
    #[cfg(test)]
    {
        PHASE_A_DROPPED.with(|dropped| dropped.set(false));
        PHASE2_SAW_PHASE_A_DROPPED.with(|seen| seen.set(false));
    }
    let proof = run_numeric_proof(
        &initial,
        max_states,
        &connectivity,
        &floors,
        &blocks,
        &terminals,
        &shops,
    );
    let mut stats = TwoPhaseStats {
        phase_a_explored: proof.explored,
        phase_b_explored: 0,
    };
    let explored = proof.explored;
    match proof.outcome {
        PhaseAOutcome::BudgetExhausted => (
            json!({"scope":"global_terminal_route","proof":"unproven","reason":"search_budget_exhausted",
        "truncated":true,"explored_states":explored,"blockers":blockers,"route":null,"first_suggestion":null}),
            stats,
        ),
        PhaseAOutcome::Complete(Some(target)) => {
            match extract_route_witness(
                &initial,
                target,
                max_states,
                &connectivity,
                &floors,
                &blocks,
                &terminals,
                &shops,
            ) {
                Phase2Outcome::Found {
                    route: best,
                    explored: phase_b_explored,
                } => {
                    stats.phase_b_explored = phase_b_explored;
                    let first = best.steps.first().cloned();
                    (
                        json!({"scope":"global_terminal_route","proof":"proven","reason":"complete terminal route found","truncated":false,
                "explored_states":explored,"terminal_hp":best.state.hp.get(),"terminal_attack":best.state.attack.get(),
                "terminal_defense":best.state.defense.get(),"blockers":blockers,"route":{"step_count":best.steps.len(),"steps":best.steps},"first_suggestion":first}),
                        stats,
                    )
                }
                Phase2Outcome::BudgetExhausted {
                    explored: phase_b_explored,
                } => {
                    stats.phase_b_explored = phase_b_explored;
                    (
                        json!({"scope":"global_terminal_route","proof":"unproven","reason":"search_budget_exhausted",
                "truncated":true,"explored_states":explored,"blockers":blockers,"route":null,"first_suggestion":null}),
                        stats,
                    )
                }
                Phase2Outcome::NoWitness {
                    explored: phase_b_explored,
                } => {
                    stats.phase_b_explored = phase_b_explored;
                    (
                        json!({"scope":"global_terminal_route","proof":"unproven","reason":"route_witness_unavailable",
                "truncated":false,"explored_states":explored,"blockers":blockers,"route":null,"first_suggestion":null}),
                        stats,
                    )
                }
            }
        }
        PhaseAOutcome::Complete(None) => (
            json!({"scope":"global_terminal_route","proof":if blockers.is_empty(){"unproven"}else{"unsupported"},"reason":"no_complete_supported_route",
        "truncated":false,"explored_states":explored,"blockers":blockers,"route":null,"first_suggestion":null}),
            stats,
        ),
    }
}

fn shadow_response(body: &[u8], state: &Mutex<ShadowState>) -> Result<Value, Value> {
    let request: Value = serde_json::from_slice(body)
        .map_err(|_| error("INVALID_JSON", "Request body must be JSON."))?;
    let request = request
        .as_object()
        .ok_or_else(|| error("INVALID_REQUEST", "Cycle request must be a JSON object."))?;
    if request.get("source").and_then(Value::as_str) != Some("mota-planning-lab-userscript") {
        return Err(error(
            "INVALID_REQUEST",
            "Unsupported cycle request source.",
        ));
    }
    if !matches!(
        request.get("intent").and_then(Value::as_str),
        Some("cycle" | "reconnect_only")
    ) {
        return Err(error(
            "INVALID_REQUEST",
            "Unsupported cycle request intent.",
        ));
    }
    let observation = request
        .get("observation")
        .and_then(Value::as_object)
        .ok_or_else(|| error("INVALID_REQUEST", "Cycle request requires observation."))?;
    let session_id = required_string(observation, "session_id")?;
    let floor_id = required_string(observation, "floor_id")?;
    let map_instance_id = required_string(observation, "map_instance_id")?;
    let mut analysis = analyze_current_floor(observation, floor_id)?;
    if let Some(object) = analysis.as_object_mut() {
        object.insert("global".to_owned(), global_analysis(observation));
    }
    let session = request
        .get("session")
        .and_then(Value::as_object)
        .ok_or_else(|| error("INVALID_REQUEST", "Cycle request requires session."))?;
    required_string(session, "mode")?;

    let mut state = state
        .lock()
        .map_err(|_| error("RUNTIME_UNAVAILABLE", "Shadow state lock failed."))?;
    state.cycle = state
        .cycle
        .checked_add(1)
        .filter(|cycle| *cycle <= MAX_SHADOW_CYCLE)
        .ok_or_else(|| error("RUNTIME_UNAVAILABLE", "Shadow cycle counter overflowed."))?;
    Ok(json!({
        "status": "idle",
        "reason": SHADOW_REASON,
        "shadow": {
            "mode": "read_only",
            "reason": SHADOW_REASON,
            "cycle": state.cycle,
            "analysis": analysis,
            "observation": {
                "session_id": session_id,
                "floor_id": floor_id,
                "map_instance_id": map_instance_id
            }
        }
    }))
}

fn handle_connection(mut stream: TcpStream, state: &Arc<Mutex<ShadowState>>) {
    let response = match read_request(&mut stream) {
        Ok(request) if request.method == "OPTIONS" && valid_preflight(&request) => {
            (204, None, preflight_headers().to_vec())
        }
        Ok(request) if request.method == "OPTIONS" => (
            403,
            Some(error(
                "CORS_PREFLIGHT_REJECTED",
                "Unsupported CORS preflight.",
            )),
            cors_headers_for_actual_request(&request),
        ),
        Ok(request) if request.method == "POST" && request.path == "/cycle" => {
            let cors_headers = cors_headers_for_actual_request(&request);
            if !valid_actual_origin(&request) {
                (
                    403,
                    Some(error(
                        "CORS_ORIGIN_REJECTED",
                        "Only the configured browser origin may call /cycle.",
                    )),
                    Vec::new(),
                )
            } else if !request.has_content_length {
                (
                    400,
                    Some(error(
                        "MALFORMED_HTTP",
                        "Content-Length is required for /cycle.",
                    )),
                    cors_headers,
                )
            } else if !valid_json_content_type(&request) {
                (
                    400,
                    Some(error(
                        "INVALID_CONTENT_TYPE",
                        "POST /cycle requires Content-Type: application/json.",
                    )),
                    cors_headers,
                )
            } else if header(&request, "x-mota-lab") != Some("1") {
                (
                    400,
                    Some(error(
                        "MISSING_MOTA_LAB_HEADER",
                        "POST /cycle requires X-Mota-Lab: 1.",
                    )),
                    cors_headers,
                )
            } else {
                match shadow_response(&request.body, state) {
                    Ok(body) => (200, Some(body), cors_headers),
                    Err(body) => (400, Some(body), cors_headers),
                }
            }
        }
        Ok(request) if request.method != "POST" => (
            405,
            Some(error(
                "METHOD_NOT_ALLOWED",
                "Only POST /cycle is available.",
            )),
            cors_headers_for_actual_request(&request),
        ),
        Ok(request) => (
            404,
            Some(error("NOT_FOUND", "Only POST /cycle is available.")),
            cors_headers_for_actual_request(&request),
        ),
        Err(failure) => (failure.status, Some(failure.body), failure.cors_headers),
    };
    let _ = write_response(&mut stream, response.0, response.1, &response.2);
}

fn main() {
    let port = match parse_port() {
        Ok(port) => port,
        Err(message) => {
            eprintln!("{message}");
            std::process::exit(2);
        }
    };
    let listener = match TcpListener::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, port)) {
        Ok(listener) => listener,
        Err(error) => {
            eprintln!("unable to bind 127.0.0.1:{port}: {error}");
            std::process::exit(1);
        }
    };
    let address = listener
        .local_addr()
        .expect("bound listener must have an address");
    println!(
        "{}",
        json!({"event": "ready", "address": address.to_string()})
    );
    let _ = std::io::stdout().flush();
    let state = Arc::new(Mutex::new(ShadowState::default()));
    for stream in listener.incoming() {
        match stream {
            Ok(stream) => handle_connection(stream, &state),
            Err(error) => eprintln!("connection error: {error}"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn terminal_node(attack: u64, defense: u64, hp: u64, _route: &str) -> SolverState {
        SolverState {
            floor: "F".to_owned(),
            x: 0,
            y: 0,
            hp: F64Bits::new(hp as f64).unwrap(),
            attack: F64Bits::new(attack as f64).unwrap(),
            defense: F64Bits::new(defense as f64).unwrap(),
            level: 0,
            gold: 0,
            experience: 0,
            yellow: 0,
            blue: 0,
            red: 0,
            inventory: Arc::new(Vec::new()),
            consumed: ConsumedBits::new(0),
            shop_counts: Arc::new(Vec::new()),
            flags: Arc::new(Vec::new()),
        }
    }

    #[test]
    fn terminal_route_order_is_attributes_then_balance_then_hp_then_route() {
        let hp_rich = NumericObjective::from_state(&terminal_node(10, 10, 10_000, "b"));
        let stronger = NumericObjective::from_state(&terminal_node(11, 10, 1, "z"));
        assert!(stronger.cmp(hp_rich).is_gt());

        let unbalanced = NumericObjective::from_state(&terminal_node(19, 1, 10_000, "a"));
        let balanced = NumericObjective::from_state(&terminal_node(10, 10, 1, "z"));
        assert!(balanced.cmp(unbalanced).is_gt());

        let low_hp = NumericObjective::from_state(&terminal_node(10, 10, 5, "a"));
        let high_hp = NumericObjective::from_state(&terminal_node(10, 10, 6, "z"));
        assert!(high_hp.cmp(low_hp).is_gt());

        let earlier = RouteStepKey::new(RouteStepSemantic::Terminal {
            floor_id: "a".into(),
            x: 0,
            y: 0,
        });
        let later = RouteStepKey::new(RouteStepSemantic::Terminal {
            floor_id: "z".into(),
            x: 0,
            y: 0,
        });
        assert!(earlier < later);

        let overflow_safe =
            NumericObjective::from_state(&terminal_node(u64::MAX, u64::MAX, 1, "a"));
        assert!(overflow_safe.cmp(stronger).is_gt());
    }

    #[test]
    fn phase2_replaces_a_shorter_route_with_a_lexically_smaller_longer_route_to_same_state() {
        let state = terminal_node(10, 10, 100, "same");
        let shorter = vec![RouteStepKey::new(RouteStepSemantic::Terminal {
            floor_id: "z".into(),
            x: 0,
            y: 0,
        })];
        let longer = vec![
            RouteStepKey::new(RouteStepSemantic::Terminal {
                floor_id: "a".into(),
                x: 0,
                y: 0,
            }),
            RouteStepKey::new(RouteStepSemantic::Terminal {
                floor_id: "z".into(),
                x: 0,
                y: 0,
            }),
        ];
        assert!(
            cmp_route_sequences(&longer, &shorter).is_lt(),
            "the longer route is deliberately lexically first"
        );
        let mut seen = HashMap::new();
        seen.insert(state.clone(), shorter);
        assert!(phase2_prefix_is_better(&seen, &state, &longer));
    }

    #[test]
    fn route_step_keys_match_legacy_canonical_json_for_all_supported_step_types() {
        let steps = vec![
            RouteStep::new(RouteStepSemantic::Door {
                floor_id: "F".into(),
                x: 1,
                y: 2,
                block_id: "door".into(),
                yellow: 1,
                blue: 2,
                red: 3,
            }),
            RouteStep::new(RouteStepSemantic::Resource {
                floor_id: "F".into(),
                x: 2,
                y: 2,
                block_id: "gem".into(),
                delta: json!({"attack":3,"keys":{"yellow":1,"blue":0,"red":0},"inventory":{"wand":1}}),
            }),
            RouteStep::new(RouteStepSemantic::Enemy {
                floor_id: "F".into(),
                x: 3,
                y: 2,
                block_id: "enemy".into(),
                hp_loss: F64Bits::new(1.5).unwrap(),
            }),
            RouteStep::new(RouteStepSemantic::Transition {
                floor_id: "F".into(),
                x: 4,
                y: 2,
                block_id: "stairs".into(),
            }),
            RouteStep::new(RouteStepSemantic::Event {
                floor_id: "F".into(),
                x: 5,
                y: 2,
                block_id: "event".into(),
                event_id: "fairy_mt0".into(),
            }),
            RouteStep::new(RouteStepSemantic::Shop {
                floor_id: "F".into(),
                shop_id: "shop".into(),
                choice_id: "shop:0".into(),
                currency: "gold".into(),
                cost: 10,
                purchase_count_before: 2,
                effects: vec![ShopRouteEffect {
                    field: "attack".into(),
                    amount: 3,
                }],
            }),
            RouteStep::new(RouteStepSemantic::Terminal {
                floor_id: "F".into(),
                x: 6,
                y: 2,
            }),
        ];
        let routes: Vec<Vec<usize>> = (0..steps.len())
            .map(|index| vec![index])
            .chain([(0..2).collect(), vec![0], vec![0, 1, 2]])
            .collect();
        for left in &routes {
            for right in &routes {
                let old_left = serde_json::to_vec(
                    &left
                        .iter()
                        .map(|index| steps[*index].value.clone())
                        .collect::<Vec<_>>(),
                )
                .unwrap();
                let old_right = serde_json::to_vec(
                    &right
                        .iter()
                        .map(|index| steps[*index].value.clone())
                        .collect::<Vec<_>>(),
                )
                .unwrap();
                let new_left = left
                    .iter()
                    .map(|index| steps[*index].key.clone())
                    .collect::<Vec<_>>();
                let new_right = right
                    .iter()
                    .map(|index| steps[*index].key.clone())
                    .collect::<Vec<_>>();
                assert_eq!(
                    cmp_route_sequences(&new_left, &new_right),
                    old_left.cmp(&old_right),
                    "left={left:?}, right={right:?}"
                );
            }
        }
    }

    #[test]
    fn phase2_budget_fails_closed_before_witness_search() {
        let mut initial = terminal_node(10, 10, 100, "initial");
        initial.consumed = ConsumedBits::from_bools(&[false]);
        let blocks = vec![SolverBlock {
            floor: "F".to_owned(),
            x: 1,
            y: 0,
            id: "extra".to_owned(),
            kind: "resource".to_owned(),
            data: json!({"delta":{"hp":0,"attack":0,"defense":0,"gold":0,"experience":0,
                "keys":{"yellow":0,"blue":0,"red":0},"inventory":{}}}),
            state_slot: Some(0),
        }];
        let floors = HashMap::from([("F".to_owned(), indexed_floor(2, vec![0]))]);
        let connectivity = ConnectivityIndex::new(&floors, &blocks);
        match extract_route_witness(
            &initial,
            NumericObjective::from_state(&initial),
            1,
            &connectivity,
            &floors,
            &blocks,
            &[("F", (0, 0))],
            &[],
        ) {
            Phase2Outcome::BudgetExhausted { explored } => assert_eq!(explored, 1),
            _ => panic!("one explored witness node must then report its finite budget"),
        }
    }

    #[test]
    fn compact_parent_route_reconstructs_original_step_format_and_order() {
        let blocks = vec![
            SolverBlock {
                floor: "F".into(),
                x: 1,
                y: 0,
                id: "yellowDoor".into(),
                kind: "door".into(),
                data: json!({}),
                state_slot: Some(0),
            },
            SolverBlock {
                floor: "F".into(),
                x: 2,
                y: 0,
                id: "redGem".into(),
                kind: "resource".into(),
                data: json!({"delta":{"hp":0,"attack":3,"defense":0,"gold":0,
                    "experience":0,"keys":{"yellow":0,"blue":0,"red":0},"inventory":{}}}),
                state_slot: Some(1),
            },
        ];
        let steps = vec![
            route_action_json(
                &RouteAction::Block {
                    index: 0,
                    action: BlockRouteAction::Door {
                        yellow: 1,
                        blue: 0,
                        red: 0,
                    },
                },
                &blocks,
            ),
            route_action_json(
                &RouteAction::Block {
                    index: 1,
                    action: BlockRouteAction::Resource,
                },
                &blocks,
            ),
        ];
        assert_eq!(
            steps,
            vec![
                json!({"step_kind":"door","floor_id":"F","x":1,"y":0,
                    "block_id":"yellowDoor","details":{"key_cost":{"yellow":1,"blue":0,"red":0}}}),
                json!({"step_kind":"resource","floor_id":"F","x":2,"y":0,
                    "block_id":"redGem","details":blocks[1].data["delta"]}),
            ]
        );
    }

    #[test]
    fn lazy_candidate_materializes_the_same_successor_and_rejects_invalid_actions() {
        let blocks = vec![SolverBlock {
            floor: "F".into(),
            x: 1,
            y: 0,
            id: "yellowDoor".into(),
            kind: "door".into(),
            data: json!({"key_cost":{"yellow":1,"blue":0,"red":0}}),
            state_slot: Some(0),
        }];
        let mut source = terminal_node(10, 10, 100, "root");
        source.yellow = 1;
        source.consumed = ConsumedBits::from_bools(&[false]);
        let candidate = PendingCandidate {
            source: 0,
            action: PendingAction::Block {
                index: 0,
                adjacent: (0, 0),
            },
        };
        let next =
            materialize_pending_action(&source, candidate.action, &blocks, &[], true).unwrap();
        assert_eq!(next.state.yellow, 0);
        assert!(block_is_consumed(&next.state, &blocks[0]));
        let step = route_action_json(next.route_action.as_ref().unwrap(), &blocks);
        assert_eq!(step["step_kind"], "door");
        assert_eq!(step["details"]["key_cost"]["yellow"], 1);

        let mut invalid = source;
        invalid.yellow = 0;
        let candidate = PendingCandidate {
            source: 0,
            action: PendingAction::Block {
                index: 0,
                adjacent: (0, 0),
            },
        };
        assert!(
            materialize_pending_action(&invalid, candidate.action, &blocks, &[], false).is_none()
        );
    }

    #[test]
    fn typed_structural_key_matches_legacy_json_fields_and_distinguishes_each_field() {
        let mut state = terminal_node(10, 11, 100, "x");
        state.floor = "F1".into();
        state.x = 2;
        state.y = 3;
        state.inventory = Arc::new(vec![("book".into(), 1)]);
        state.consumed = ConsumedBits::from_bools(&[false, true]);
        state.shop_counts = Arc::new(vec![2]);
        state.level = 4;
        state.flags = Arc::new(vec![("quest".into(), 1)]);
        let key = StructuralKey::from(&state);
        let legacy = json!({"floor":state.floor,"x":state.x,"y":state.y,
            "inventory":&*state.inventory,"consumed":&*state.consumed.words,
            "shops":&*state.shop_counts,"level":state.level,"flags":&*state.flags});
        assert_eq!(legacy.as_object().unwrap().len(), 8);
        assert_eq!(legacy["floor"], key.floor);
        assert_eq!(legacy["x"], key.x);
        assert_eq!(legacy["y"], key.y);
        assert_eq!(legacy["inventory"], json!(&*key.inventory));
        assert_eq!(legacy["consumed"], json!(&*key.consumed.words));
        assert_eq!(legacy["shops"], json!(&*key.shop_counts));
        assert_eq!(legacy["level"], key.level);
        assert_eq!(legacy["flags"], json!(&*key.flags));

        let mut variants = Vec::new();
        let mut changed = state.clone();
        changed.floor = "F2".into();
        variants.push(changed);
        let mut changed = state.clone();
        changed.x += 1;
        variants.push(changed);
        let mut changed = state.clone();
        changed.y += 1;
        variants.push(changed);
        let mut changed = state.clone();
        Arc::make_mut(&mut changed.inventory).push(("cross".into(), 1));
        variants.push(changed);
        let mut changed = state.clone();
        changed.consumed.set(0, true).unwrap();
        variants.push(changed);
        let mut changed = state.clone();
        Arc::make_mut(&mut changed.shop_counts)[0] += 1;
        variants.push(changed);
        let mut changed = state.clone();
        changed.level += 1;
        variants.push(changed);
        let mut changed = state.clone();
        Arc::make_mut(&mut changed.flags)[0].1 += 1;
        variants.push(changed);
        for changed in variants {
            assert_ne!(StructuralKey::from(&changed), key);
        }
    }

    #[test]
    fn solver_state_large_collections_share_until_branch_mutation() {
        let mut parent = terminal_node(10, 10, 100, "x");
        parent.inventory = Arc::new(vec![("book".into(), 1)]);
        parent.consumed = ConsumedBits::from_bools(&[false, false]);
        parent.shop_counts = Arc::new(vec![0]);
        parent.flags = Arc::new(vec![("quest".into(), 1)]);
        let mut child = parent.clone();
        assert!(Arc::ptr_eq(&parent.inventory, &child.inventory));
        assert!(Arc::ptr_eq(&parent.consumed.words, &child.consumed.words));
        assert!(Arc::ptr_eq(&parent.shop_counts, &child.shop_counts));
        assert!(Arc::ptr_eq(&parent.flags, &child.flags));

        state_set(&mut child.inventory, "cross", 1);
        child.consumed.set(0, true).unwrap();
        Arc::make_mut(&mut child.shop_counts)[0] = 1;
        state_set(&mut child.flags, "quest", 2);
        assert!(!Arc::ptr_eq(&parent.inventory, &child.inventory));
        assert!(!Arc::ptr_eq(&parent.consumed.words, &child.consumed.words));
        assert!(!Arc::ptr_eq(&parent.shop_counts, &child.shop_counts));
        assert!(!Arc::ptr_eq(&parent.flags, &child.flags));
        assert_eq!(&*parent.inventory, &[("book".into(), 1)]);
        assert_eq!(parent.consumed.read(0), Some(false));
        assert_eq!(parent.consumed.read(1), Some(false));
        assert_eq!(&*parent.shop_counts, &[0]);
        assert_eq!(&*parent.flags, &[("quest".into(), 1)]);
        assert_eq!(state_count(&child.inventory, "cross"), 1);
        assert_eq!(child.consumed.read(0), Some(true));
        assert_eq!(child.shop_counts[0], 1);
        assert_eq!(state_count(&child.flags, "quest"), 2);
    }

    #[test]
    fn consumed_slots_cover_only_mutable_blocks_and_all_audited_event_targets() {
        let block = |floor: &str, x, y, kind: &str, initial_active: Option<bool>| SolverBlock {
            floor: floor.into(),
            x,
            y,
            id: kind.into(),
            kind: kind.into(),
            data: initial_active.map_or_else(|| json!({}), |value| json!({"initial_active":value})),
            state_slot: None,
        };
        for kind in ["door", "enemy", "resource", "event"] {
            assert!(block_needs_state_slot(&block("F", 0, 0, kind, None)));
        }
        for (floor, x, y) in [
            ("MT20", 6, 8),
            ("MT16", 5, 5),
            ("MT2", 2, 7),
            ("MT18", 6, 9),
            ("MT18", 6, 10),
            ("MT18", 11, 11),
            ("MT23w", 5, 6),
            ("MT23e", 7, 6),
        ] {
            assert!(block_needs_state_slot(&block(floor, x, y, "opaque", None)));
        }
        for x in 5..=7 {
            for y in 2..=4 {
                assert!(block_needs_state_slot(&block(
                    "MT_1", x, y, "terrain", None
                )));
            }
        }
        assert!(block_needs_state_slot(&block(
            "F",
            0,
            0,
            "terrain",
            Some(false)
        )));
        for kind in ["opaque", "terrain", "transition", "shop"] {
            assert!(!block_needs_state_slot(&block("F", 0, 0, kind, None)));
        }
    }

    #[test]
    fn compressed_consumed_projection_matches_legacy_full_block_projection() {
        let mut blocks = vec![
            SolverBlock {
                floor: "F".into(),
                x: 0,
                y: 0,
                id: "wall".into(),
                kind: "terrain".into(),
                data: json!({}),
                state_slot: None,
            },
            SolverBlock {
                floor: "F".into(),
                x: 1,
                y: 0,
                id: "door".into(),
                kind: "door".into(),
                data: json!({}),
                state_slot: Some(0),
            },
            SolverBlock {
                floor: "F".into(),
                x: 2,
                y: 0,
                id: "hidden".into(),
                kind: "opaque".into(),
                data: json!({"initial_active":false}),
                state_slot: Some(1),
            },
            SolverBlock {
                floor: "F".into(),
                x: 3,
                y: 0,
                id: "stairs".into(),
                kind: "transition".into(),
                data: json!({}),
                state_slot: None,
            },
        ];
        let legacy = [false, true, false, false];
        let mut state = terminal_node(10, 10, 100, "x");
        state.consumed = ConsumedBits::from_bools(&[legacy[1], legacy[2]]);
        for (index, block) in blocks.iter().enumerate() {
            assert_eq!(block_is_consumed(&state, block), legacy[index]);
        }
        assert!(!set_block_consumed(&mut state, &blocks[0], true));
        assert_eq!(state.consumed.read(0), Some(true));
        assert_eq!(state.consumed.read(1), Some(false));
        assert!(set_block_consumed(&mut state, &blocks[2], true));
        assert!(block_is_consumed(&state, &blocks[2]));
        blocks[2].state_slot = None;
        assert!(!set_block_consumed(&mut state, &blocks[2], false));
    }

    #[test]
    fn consumed_bits_cross_word_boundaries_and_clear_tail_bits() {
        assert_eq!(ConsumedBits::new(754).words.len(), 12);
        let mut bits = ConsumedBits::new(66);
        assert_eq!(bits.words.len(), 2);
        bits.set_many(&[(63, true), (64, true), (65, true)])
            .unwrap();
        assert_eq!(bits.read(62), Some(false));
        assert_eq!(bits.read(63), Some(true));
        assert_eq!(bits.read(64), Some(true));
        assert_eq!(bits.read(65), Some(true));
        assert_eq!(bits.read(66), None);
        assert_eq!(bits.words[1], 0b11);

        assert!(bits.set(66, true).is_err());
        assert_eq!(bits.words[1], 0b11);
    }

    #[test]
    fn consumed_bits_batch_preflight_is_atomic_and_cow_isolated() {
        let mut parent = ConsumedBits::new(66);
        let before = parent.words.clone();
        assert!(parent.set_many(&[(1, true), (66, true)]).is_err());
        assert!(Arc::ptr_eq(&before, &parent.words));
        assert_eq!(parent.read(1), Some(false));

        let mut child = parent.clone();
        assert!(Arc::ptr_eq(&parent.words, &child.words));
        child.set_many(&[(1, true), (65, true)]).unwrap();
        assert!(!Arc::ptr_eq(&parent.words, &child.words));
        assert_eq!(parent.read(1), Some(false));
        assert_eq!(parent.read(65), Some(false));
        assert_eq!(child.read(1), Some(true));
        assert_eq!(child.read(65), Some(true));
    }

    fn transition_block(
        floor: &str,
        x: u64,
        id: &str,
        target_floor: &str,
        target_x: u64,
    ) -> SolverBlock {
        SolverBlock {
            floor: floor.into(),
            x,
            y: 0,
            id: id.into(),
            kind: "transition".into(),
            data: json!({"block_id":id,"floor_id":floor,"initial_active":true,
                "kind":"transition","numeric_id":1,"x":x,"y":0,
                "target":{"floor_id":target_floor,"x":target_x,"y":0}}),
            state_slot: None,
        }
    }

    fn indexed_floor(width: u64, blocks: Vec<usize>) -> SolverFloor {
        SolverFloor {
            width,
            height: 1,
            cells: (0..width).map(|x| (x, 0)).collect(),
            blocks,
        }
    }

    #[test]
    fn reversible_index_requires_unique_mutual_pure_nonself_transitions() {
        let mut blocks = vec![
            transition_block("A", 2, "a", "B", 0),
            transition_block("B", 0, "b", "A", 1),
        ];
        assert_eq!(reversible_transition_partner(0, &blocks), Some(1));
        assert_eq!(reversible_transition_partner(1, &blocks), Some(0));

        let mut inactive = blocks.clone();
        inactive[1].data["initial_active"] = json!(false);
        assert_eq!(reversible_transition_partner(0, &inactive), None);
        let mut effectful = blocks.clone();
        effectful[1].data["event"] = json!({"id":"side-effect"});
        assert_eq!(reversible_transition_partner(0, &effectful), None);
        assert_eq!(reversible_transition_partner(0, &blocks[..1]), None);

        blocks.push(transition_block("A", 0, "ambiguous", "B", 0));
        assert_eq!(reversible_transition_partner(1, &blocks), None);
        let self_loop = vec![transition_block("A", 1, "self", "A", 1)];
        assert_eq!(reversible_transition_partner(0, &self_loop), None);
    }

    #[test]
    fn lightweight_view_collects_remote_boundaries_shops_and_dynamic_terminal() {
        let blocks = vec![
            transition_block("A", 2, "a", "B", 0),
            transition_block("B", 0, "b", "A", 1),
            SolverBlock {
                floor: "B".into(),
                x: 2,
                y: 0,
                id: "door".into(),
                kind: "door".into(),
                data: json!({"key_cost":{"yellow":1,"blue":0,"red":0}}),
                state_slot: Some(0),
            },
            SolverBlock {
                floor: "B".into(),
                x: 1,
                y: 0,
                id: "remoteShop".into(),
                kind: "shop".into(),
                data: json!({"shop_id":"remoteShop"}),
                state_slot: None,
            },
        ];
        let floors = HashMap::from([
            ("A".into(), indexed_floor(3, vec![0])),
            ("B".into(), indexed_floor(4, vec![1, 2, 3])),
        ]);
        let index = ConnectivityIndex::new(&floors, &blocks);
        let mut state = terminal_node(10, 10, 100, "x");
        state.floor = "A".into();
        state.x = 0;
        state.y = 0;
        state.consumed = ConsumedBits::from_bools(&[false]);
        let terminals = [("B", (3, 0))];
        let closed = index.view(&state, &floors, &blocks, &terminals, true);
        assert_eq!(
            closed
                .boundaries
                .iter()
                .map(|item| item.index)
                .collect::<Vec<_>>(),
            vec![2]
        );
        assert_eq!(closed.boundaries[0].navigation.as_slice(), &[0]);
        assert_eq!(closed.shops["remoteShop"].0, "B");
        assert_eq!(closed.shops["remoteShop"].2.as_slice(), &[0]);
        assert!(closed.terminals.is_empty());

        assert!(set_block_consumed(&mut state, &blocks[2], true));
        let opened = index.view(&state, &floors, &blocks, &terminals, true);
        assert_eq!(opened.terminals.len(), 1);
        assert_eq!(opened.terminals[0].floor, "B");
        assert_eq!(opened.terminals[0].navigation.as_slice(), &[0]);
    }

    #[test]
    fn duplicate_component_entries_emit_each_remote_boundary_once() {
        let blocks = vec![
            transition_block("A", 1, "a1", "B", 0),
            transition_block("B", 0, "b1", "A", 0),
            transition_block("A", 3, "a2", "B", 4),
            transition_block("B", 4, "b2", "A", 4),
            SolverBlock {
                floor: "B".into(),
                x: 2,
                y: 0,
                id: "gem".into(),
                kind: "resource".into(),
                data: json!({"delta":{}}),
                state_slot: Some(0),
            },
        ];
        let floors = HashMap::from([
            ("A".into(), indexed_floor(5, vec![0, 2])),
            ("B".into(), indexed_floor(5, vec![1, 3, 4])),
        ]);
        let index = ConnectivityIndex::new(&floors, &blocks);
        let mut state = terminal_node(10, 10, 100, "x");
        state.floor = "A".into();
        state.x = 2;
        state.y = 0;
        state.consumed = ConsumedBits::from_bools(&[false]);
        let view = index.view(&state, &floors, &blocks, &[], true);
        assert_eq!(
            view.boundaries
                .iter()
                .filter(|item| item.index == 4)
                .count(),
            1
        );
    }

    fn reversible_terminal_observation() -> Value {
        json!({
            "session_id":"S","floor_id":"A","map_instance_id":"M",
            "dimensions":{"width":3,"height":1},"topology":{"kind":"rectangle"},
            "hero":{"hp":100,"attack":10,"defense":10,"gold":0,"experience":0,"loc":{"x":0,"y":0}},
            "keys":{"yellow":0,"blue":0,"red":0},"blocks":[],
            "engine_model":{"inventory":{"classes":{}},"solver_model":{"protocol":1,
                "terminal":{"kind":"location","floor_id":"B","x":2,"y":0},"blockers":[],"shops":[],
                "floors":[
                    {"floor_id":"A","width":3,"height":1,"topology":{"kind":"rectangle"},"blocks":[
                        {"floor_id":"A","x":2,"y":0,"block_id":"up","numeric_id":1,"kind":"transition","initial_active":true,
                         "target":{"floor_id":"B","x":0,"y":0}}]},
                    {"floor_id":"B","width":3,"height":1,"topology":{"kind":"rectangle"},"blocks":[
                        {"floor_id":"B","x":0,"y":0,"block_id":"down","numeric_id":2,"kind":"transition","initial_active":true,
                         "target":{"floor_id":"A","x":1,"y":0}}]}
                ]}}
        })
    }

    fn terminal_after_remote_resource_observation() -> Value {
        serde_json::from_str(
            r#"{
              "session_id":"S","floor_id":"A","map_instance_id":"M",
              "dimensions":{"width":4,"height":2},"topology":{"kind":"rectangle"},
              "hero":{"hp":100,"attack":10,"defense":10,"gold":0,"experience":0,"loc":{"x":0,"y":0}},
              "keys":{"yellow":0,"blue":0,"red":0},"blocks":[],
              "engine_model":{"inventory":{"classes":{}},"solver_model":{"protocol":1,
                "terminal":{"kind":"location","floor_id":"B","x":2,"y":0},"blockers":[],"shops":[],
                "floors":[
                  {"floor_id":"A","width":4,"height":2,"topology":{"kind":"rectangle"},"blocks":[
                    {"floor_id":"A","x":1,"y":0,"block_id":"redGem","numeric_id":1,"kind":"resource",
                     "delta":{"hp":0,"attack":5,"defense":0,"gold":0,"experience":0,"keys":{"yellow":0,"blue":0,"red":0},"inventory":{}}},
                    {"floor_id":"A","x":3,"y":0,"block_id":"up","numeric_id":2,"kind":"transition","initial_active":true,
                     "target":{"floor_id":"B","x":0,"y":0}}]},
                  {"floor_id":"B","width":3,"height":1,"topology":{"kind":"rectangle"},"blocks":[
                    {"floor_id":"B","x":0,"y":0,"block_id":"down","numeric_id":3,"kind":"transition","initial_active":true,
                     "target":{"floor_id":"A","x":2,"y":0}}]}
                ]}}
            }"#,
        )
        .unwrap()
    }

    #[test]
    fn terminal_observation_still_expands_same_region_resource_candidates() {
        let response = shadow_response(
            &request_with(terminal_after_remote_resource_observation()),
            &Mutex::new(ShadowState::default()),
        )
        .unwrap();
        let global = &response["shadow"]["analysis"]["global"];
        assert_eq!(global["proof"], "proven");
        assert_eq!(global["terminal_attack"], 15.0);
        let kinds: Vec<_> = global["route"]["steps"]
            .as_array()
            .unwrap()
            .iter()
            .map(|step| step["step_kind"].as_str().unwrap())
            .collect();
        assert_eq!(kinds, vec!["resource", "transition", "terminal"]);
    }

    #[test]
    fn reversible_transition_is_navigation_not_a_search_successor() {
        let response = shadow_response(
            &request_with(reversible_terminal_observation()),
            &Mutex::new(ShadowState::default()),
        )
        .unwrap();
        let global = &response["shadow"]["analysis"]["global"];
        assert_eq!(global["proof"], "proven");
        assert_eq!(global["explored_states"], 1);
        let kinds: Vec<_> = global["route"]["steps"]
            .as_array()
            .unwrap()
            .iter()
            .map(|step| step["step_kind"].as_str().unwrap())
            .collect();
        assert_eq!(kinds, vec!["transition", "terminal"]);
        assert_eq!(global["route"]["steps"][0]["floor_id"], "A");
        assert_eq!(global["route"]["steps"][1]["floor_id"], "B");
    }

    #[test]
    fn audited_resource_math_keeps_javascript_fractional_number_semantics() {
        let mut state = terminal_node(10, 11, 1001, "x");
        add_delta(
            &mut state,
            &json!({"hp":1000,"attack":10,"defense":10,
            "gold":0,"experience":0,"level":1,"keys":{"yellow":1,"blue":1,"red":1},
            "inventory":{},"multiply":{"hp":2}}),
        )
        .unwrap();
        assert_eq!(state.level, 1);
        assert_eq!(state.hp.get(), 4002.0);
        assert_eq!((state.yellow, state.blue, state.red), (1, 1, 1));
        state_set(&mut state.inventory, "cross", 1);
        let block = SolverBlock {
            floor: "MT0".into(),
            x: 5,
            y: 9,
            id: "fairy".into(),
            kind: "event".into(),
            data: json!({"event":{"id":"fairy_mt0"}}),
            state_slot: Some(0),
        };
        let target = SolverBlock {
            floor: "MT20".into(),
            x: 6,
            y: 8,
            id: "hidden".into(),
            kind: "opaque".into(),
            data: json!({"initial_active":false}),
            state_slot: Some(1),
        };
        state.consumed = ConsumedBits::from_bools(&[false, true]);
        let details = apply_audited_event(&mut state, &block, 0, &[block.clone(), target]).unwrap();
        assert_eq!(details["event_id"], "fairy_mt0");
        assert_eq!(state.attack.get(), 20.0 * 4.0 / 3.0);
        assert!(!state.attack.get().fract().eq(&0.0));
    }

    #[test]
    fn audited_wand_gate_preserves_the_two_failure_behaviors() {
        let gate_once = SolverBlock {
            floor: "MT22".into(),
            x: 6,
            y: 3,
            id: "fairy".into(),
            kind: "event".into(),
            data: json!({"event":{"id":"wand_gate_remove_on_failure"}}),
            state_slot: Some(0),
        };
        let gate_retry = SolverBlock {
            floor: "MT22".into(),
            x: 7,
            y: 3,
            id: "fairy".into(),
            kind: "event".into(),
            data: json!({"event":{"id":"wand_gate_retry"}}),
            state_slot: Some(1),
        };
        let wand = SolverBlock {
            floor: "MT23w".into(),
            x: 5,
            y: 6,
            id: "skill1".into(),
            kind: "resource".into(),
            data: json!({}),
            state_slot: Some(2),
        };
        let blocks = vec![gate_once.clone(), gate_retry.clone(), wand];
        let mut once = terminal_node(10, 10, 100, "x");
        once.consumed = ConsumedBits::from_bools(&[false; 3]);
        assert!(apply_audited_event(&mut once, &gate_once, 0, &blocks).is_some());
        assert_eq!(once.consumed.read(0), Some(true));
        let mut retry = terminal_node(10, 10, 100, "x");
        retry.consumed = ConsumedBits::from_bools(&[false; 3]);
        assert!(apply_audited_event(&mut retry, &gate_retry, 1, &blocks).is_none());
        assert_eq!(retry.consumed.read(1), Some(false));
    }

    #[test]
    fn consumed_opaque_blocks_no_longer_obstruct_reachability() {
        let block = SolverBlock {
            floor: "F".into(),
            x: 1,
            y: 0,
            id: "old-event".into(),
            kind: "opaque".into(),
            data: json!({"numeric_id":99}),
            state_slot: Some(0),
        };
        let floor = SolverFloor {
            width: 3,
            height: 1,
            cells: HashSet::from([(0, 0), (1, 0), (2, 0)]),
            blocks: vec![0],
        };
        let floors = HashMap::from([("F".into(), floor)]);
        let mut state = terminal_node(10, 10, 100, "x");
        state.floor = "F".into();
        state.consumed = ConsumedBits::from_bools(&[true]);
        let index = ConnectivityIndex::new(&floors, std::slice::from_ref(&block));
        let (reachable, _) = index.local_reachable(&state, "F", (state.x, state.y), &[block]);
        assert!(reachable[2]);
    }

    #[test]
    fn audited_wand_success_replaces_nine_blocks_and_octopus_remains_fightable() {
        let gate = SolverBlock {
            floor: "MT22".into(),
            x: 7,
            y: 3,
            id: "fairy".into(),
            kind: "event".into(),
            data: json!({"numeric_id":0,"event":{"id":"wand_gate_retry"}}),
            state_slot: Some(0),
        };
        let positions = [
            (5, 2, 189, 181),
            (6, 2, 190, 182),
            (7, 2, 191, 183),
            (5, 3, 192, 184),
            (6, 3, 193, 185),
            (7, 3, 194, 186),
            (5, 4, 195, 187),
            (6, 4, 257, 258),
            (7, 4, 196, 188),
        ];
        let mut blocks = vec![gate.clone()];
        for (x, y, old, new) in positions {
            blocks.push(SolverBlock {
                floor: "MT_1".into(),
                x,
                y,
                id: format!("old{old}"),
                kind: if old == 257 { "enemy" } else { "terrain" }.into(),
                data: json!({"numeric_id":old}),
                state_slot: Some(blocks.len()),
            });
            blocks.push(SolverBlock {
                floor: "MT_1".into(),
                x,
                y,
                id: if new == 258 {
                    "octopus".into()
                } else {
                    format!("new{new}")
                },
                kind: if new == 258 { "enemy" } else { "terrain" }.into(),
                data: if new == 258 {
                    json!({"numeric_id":258,"enemy":{"hp":99999,"attack":5000,
                        "defense":4000,"gold":0,"experience":0}})
                } else {
                    json!({"numeric_id":new})
                },
                state_slot: Some(blocks.len()),
            });
        }
        let mut state = terminal_node(5001, 5000, 200000, "x");
        state.floor = "MT_1".into();
        state.x = 6;
        state.y = 5;
        state.consumed = ConsumedBits::from_bools(
            &(0..blocks.len())
                .map(|index| index > 0 && index % 2 == 0)
                .collect::<Vec<_>>(),
        );
        assert!(apply_audited_event(&mut state, &gate, 0, &blocks).is_some());
        for (x, y, _, new) in positions {
            let active: Vec<_> = blocks
                .iter()
                .enumerate()
                .filter(|(index, block)| {
                    block.floor == "MT_1"
                        && block.x == x
                        && block.y == y
                        && state.consumed.read(*index) == Some(false)
                })
                .collect();
            assert_eq!(active.len(), 1);
            assert_eq!(active[0].1.data["numeric_id"], new);
        }
        let floor_indices: Vec<_> = (1..blocks.len()).collect();
        let floor = SolverFloor {
            width: 13,
            height: 13,
            cells: (0..13).flat_map(|y| (0..13).map(move |x| (x, y))).collect(),
            blocks: floor_indices,
        };
        let floors = HashMap::from([("MT_1".into(), floor)]);
        let index = ConnectivityIndex::new(&floors, &blocks);
        let (reachable, _) = index.local_reachable(&state, "MT_1", (state.x, state.y), &blocks);
        assert!(reachable[4 * 13 + 5]);
        assert!(!reachable[4 * 13 + 6]);
        let octopus = blocks
            .iter()
            .position(|block| block.data["numeric_id"] == 258)
            .unwrap();
        assert!(enemy_loss(&state, &blocks[octopus].data["enemy"]).is_some());
        state.consumed.set(octopus, true).unwrap();
        let (reachable, _) = index.local_reachable(&state, "MT_1", (state.x, state.y), &blocks);
        assert!(reachable[4 * 13 + 6]);
    }

    #[test]
    fn nonzero_floor_local_switches_take_the_already_started_event_branches() {
        let thief = SolverBlock {
            floor: "MT4".into(),
            x: 6,
            y: 1,
            id: "thief".into(),
            kind: "event".into(),
            data: json!({"event":{"id":"thief_quest"}}),
            state_slot: Some(0),
        };
        let mt2_door = SolverBlock {
            floor: "MT2".into(),
            x: 2,
            y: 7,
            id: "door".into(),
            kind: "door".into(),
            data: json!({}),
            state_slot: Some(1),
        };
        let road_a = SolverBlock {
            floor: "MT18".into(),
            x: 6,
            y: 9,
            id: "wall".into(),
            kind: "opaque".into(),
            data: json!({}),
            state_slot: Some(2),
        };
        let road_b = SolverBlock {
            floor: "MT18".into(),
            x: 6,
            y: 10,
            id: "wall".into(),
            kind: "opaque".into(),
            data: json!({}),
            state_slot: Some(3),
        };
        let blocks = vec![thief.clone(), mt2_door, road_a, road_b];
        let mut state = terminal_node(10, 10, 100, "x");
        state.flags = Arc::new(vec![("switch:MT4:6,1:A".into(), 2)]);
        state.inventory = Arc::new(vec![("icePickaxe".into(), 1)]);
        state.consumed = ConsumedBits::from_bools(&vec![false; blocks.len()]);
        assert!(apply_audited_event(&mut state, &thief, 0, &blocks).is_some());
        assert_eq!(state.consumed.read(1), Some(false));
        assert_eq!(state.consumed.read(2), Some(true));
        assert_eq!(state.consumed.read(3), Some(true));
        assert_eq!(state_count(&state.inventory, "icePickaxe"), 0);

        let princess = SolverBlock {
            floor: "MT18".into(),
            x: 6,
            y: 5,
            id: "princess".into(),
            kind: "event".into(),
            data: json!({"event":{"id":"princess_quest"}}),
            state_slot: Some(4),
        };
        state.flags = Arc::new(vec![("switch:MT18:6,5:A".into(), 1)]);
        state.consumed = ConsumedBits::from_bools(&[false; 5]);
        let princess_blocks = [blocks, vec![princess.clone()]].concat();
        assert!(apply_audited_event(&mut state, &princess, 4, &princess_blocks).is_none());
    }

    fn request() -> Vec<u8> {
        serde_json::to_vec(&json!({
            "source": "mota-planning-lab-userscript",
            "intent": "cycle",
            "session": {"mode": "new_game"},
            "observation": {
                "session_id": "S",
                "floor_id": "F",
                "map_instance_id": "M",
                "dimensions": {"width": 3, "height": 3},
                "topology": {"kind": "rectangle"},
                "hero": {"hp": 100, "loc": {"x": 1, "y": 1}},
                "keys": {"yellow": 0, "blue": 0, "red": 0},
                "blocks": []
            }
        }))
        .expect("test request JSON")
    }

    fn request_with(observation: Value) -> Vec<u8> {
        serde_json::to_vec(&json!({
            "source": "mota-planning-lab-userscript",
            "intent": "cycle",
            "session": {"mode": "new_game"},
            "observation": observation
        }))
        .expect("test request JSON")
    }

    fn global_observation(search_budget: Option<u64>) -> Value {
        let mut solver = json!({
            "protocol": 1,
            "terminal": {"kind":"location","floor_id":"F2","x":4,"y":0},
            "blockers": [], "shops": [{"supported":true,"shop_id":"moneyShop","repeatable":true,"choices":[
                {"choice_id":"moneyShop:0:attack:5:10","index":0,"text":"attack+5","cost":10,
                 "base_cost":10,"increment_per_purchase":0,
                 "effect":{"field":"attack","amount":5},"counter_flag":"shop_atk","purchase_count":0}
            ]}],
            "floors": [
                {"floor_id":"F1","width":4,"height":1,"topology":{"kind":"rectangle"},"blocks":[
                    {"floor_id":"F1","x":1,"y":0,"block_id":"redGem","numeric_id":1,"kind":"resource",
                     "delta":{"hp":0,"attack":5,"defense":0,"gold":10,"experience":0,"keys":{"yellow":1,"blue":0,"red":0},"inventory":{}}},
                    {"floor_id":"F1","x":2,"y":0,"block_id":"guard","numeric_id":2,"kind":"enemy",
                     "enemy":{"hp":10,"attack":8,"defense":7,"gold":0,"experience":0,"special":[]}},
                    {"floor_id":"F1","x":3,"y":0,"block_id":"downFloor","numeric_id":3,"kind":"transition",
                     "target":{"floor_id":"F2","x":0,"y":0}}
                ]},
                {"floor_id":"F2","width":5,"height":3,"topology":{"kind":"rectangle"},"blocks":[
                    {"floor_id":"F2","x":1,"y":0,"block_id":"moneyShop","numeric_id":4,"kind":"shop","shop_id":"moneyShop"},
                    {"floor_id":"F2","x":2,"y":0,"block_id":"boss","numeric_id":5,"kind":"enemy",
                     "enemy":{"hp":10,"attack":8,"defense":12,"gold":0,"experience":0,"special":[]}},
                    {"floor_id":"F2","x":3,"y":0,"block_id":"yellowDoor","numeric_id":6,"kind":"door",
                     "key_cost":{"yellow":1,"blue":0,"red":0}},
                    {"floor_id":"F2","x":0,"y":1,"block_id":"sideEnemy","numeric_id":7,"kind":"enemy",
                     "enemy":{"hp":20,"attack":8,"defense":0,"gold":0,"experience":0,"special":[]}},
                    {"floor_id":"F2","x":0,"y":2,"block_id":"sidePotion","numeric_id":8,"kind":"resource",
                     "delta":{"hp":10,"attack":0,"defense":0,"gold":0,"experience":0,"keys":{"yellow":0,"blue":0,"red":0},"inventory":{}}},
                    {"floor_id":"F2","x":1,"y":1,"block_id":"wall1","numeric_id":9,"kind":"opaque","reason":"wall"},
                    {"floor_id":"F2","x":1,"y":2,"block_id":"wall1b","numeric_id":14,"kind":"opaque","reason":"wall"},
                    {"floor_id":"F2","x":2,"y":1,"block_id":"deadBranchDoor","numeric_id":10,"kind":"door",
                     "key_cost":{"yellow":1,"blue":0,"red":0}},
                    {"floor_id":"F2","x":2,"y":2,"block_id":"jackpot","numeric_id":13,"kind":"resource",
                     "delta":{"hp":100,"attack":0,"defense":0,"gold":0,"experience":0,"keys":{"yellow":0,"blue":0,"red":0},"inventory":{}}},
                    {"floor_id":"F2","x":3,"y":1,"block_id":"wall3","numeric_id":11,"kind":"opaque","reason":"wall"},
                    {"floor_id":"F2","x":4,"y":1,"block_id":"wall4","numeric_id":12,"kind":"opaque","reason":"wall"}
                ]}
            ]
        });
        if let Some(budget) = search_budget {
            solver["search_budget"] = Value::from(budget);
        }
        json!({
            "session_id":"S","floor_id":"F1","map_instance_id":"M",
            "dimensions":{"width":4,"height":1},"topology":{"kind":"rectangle"},
            "hero":{"hp":30,"attack":5,"defense":5,"gold":0,"experience":0,"loc":{"x":0,"y":0}},
            "keys":{"yellow":0,"blue":0,"red":0},"blocks":[],
            "engine_model":{"inventory":{"classes":{},"key_slots":{"yellow":"yellowKey","blue":"blueKey","red":"redKey"}},"solver_model":solver}
        })
    }

    fn two_terminal_routes(search_budget: u64) -> Value {
        let mut value: Value = serde_json::from_str(r#"{
          "session_id":"S","floor_id":"F","map_instance_id":"M",
          "dimensions":{"width":3,"height":2},"topology":{"kind":"rectangle"},
          "hero":{"hp":10,"attack":1,"defense":1,"gold":0,"experience":0,"loc":{"x":0,"y":0}},
          "keys":{"yellow":0,"blue":0,"red":0},"blocks":[],
          "engine_model":{"inventory":{"classes":{},"key_slots":{"yellow":"yellowKey","blue":"blueKey","red":"redKey"}},
            "solver_model":{"protocol":1,"terminal":{"kind":"location","floor_id":"F","x":2,"y":0},"blockers":[],"shops":[],
              "floors":[{"floor_id":"F","width":3,"height":2,"topology":{"kind":"valid_cells","valid_cells":[{"x":0,"y":0},{"x":1,"y":0},{"x":2,"y":0},{"x":0,"y":1}]},"blocks":[
                {"floor_id":"F","x":1,"y":0,"block_id":"smallPotion","numeric_id":1,"kind":"resource","delta":{"hp":1,"attack":0,"defense":0,"gold":0,"experience":0,"keys":{"yellow":0,"blue":0,"red":0},"inventory":{}}},
                {"floor_id":"F","x":0,"y":1,"block_id":"largePotion","numeric_id":2,"kind":"resource","delta":{"hp":10,"attack":0,"defense":0,"gold":0,"experience":0,"keys":{"yellow":0,"blue":0,"red":0},"inventory":{}}}
              ]}]}}
        }"#).unwrap();
        value["engine_model"]["solver_model"]["search_budget"] = json!(search_budget);
        value
    }

    fn any_location_terminal_observation(locations: &[(u64, u64)]) -> Value {
        json!({
            "session_id":"S","floor_id":"F","map_instance_id":"M",
            "dimensions":{"width":3,"height":2},"topology":{"kind":"rectangle"},
            "hero":{"hp":10,"attack":1,"defense":1,"gold":0,"experience":0,"loc":{"x":0,"y":0}},
            "keys":{"yellow":0,"blue":0,"red":0},"blocks":[],
            "engine_model":{"inventory":{"classes":{}},"solver_model":{
                "protocol":1,
                "terminal":{"kind":"any_location","locations":locations.iter().map(|(x,y)|
                    json!({"kind":"location","floor_id":"F","x":x,"y":y})).collect::<Vec<_>>()},
                "blockers":[],"shops":[],
                "floors":[{"floor_id":"F","width":3,"height":2,"topology":{"kind":"rectangle"},"blocks":[]}]}}
        })
    }

    fn phase2_budget_response_observation() -> Value {
        serde_json::from_str(
            r#"{
              "session_id":"S","floor_id":"F","map_instance_id":"M",
              "dimensions":{"width":2,"height":2},"topology":{"kind":"rectangle"},
              "hero":{"hp":10,"attack":1,"defense":1,"gold":0,"experience":0,"loc":{"x":0,"y":0}},
              "keys":{"yellow":0,"blue":0,"red":0},"blocks":[],
              "engine_model":{"inventory":{"classes":{}},"solver_model":{
                "protocol":1,"search_budget":4,
                "terminal":{"kind":"location","floor_id":"F","x":0,"y":0},
                "blockers":[],"shops":[],
                "floors":[{"floor_id":"F","width":2,"height":2,"topology":{"kind":"rectangle"},"blocks":[
                  {"floor_id":"F","x":1,"y":0,"block_id":"z_resource","numeric_id":1,"kind":"resource",
                   "delta":{"hp":0,"attack":0,"defense":0,"gold":0,"experience":0,"keys":{"yellow":0,"blue":0,"red":0},"inventory":{}}},
                  {"floor_id":"F","x":0,"y":1,"block_id":"a_resource","numeric_id":2,"kind":"resource",
                   "delta":{"hp":0,"attack":0,"defense":0,"gold":0,"experience":0,"keys":{"yellow":0,"blue":0,"red":0},"inventory":{}}}
                ]}]}}
            }"#,
        )
        .unwrap()
    }

    // Both strategic transitions reach exactly the same SolverState. Their
    // declaration order makes Phase A FIFO accept `z_first` before `a_later`,
    // so an implementation that retains only the Phase A predecessor would
    // leak a lexically larger witness. Phase B must recover `a_later`.
    fn fifo_same_state_tie_observation(include_cycle: bool) -> Value {
        let mut blocks = vec![
            json!({"floor_id":"A","x":1,"y":0,"block_id":"z_first","numeric_id":1,"kind":"transition",
                "target":{"floor_id":"B","x":0,"y":0}}),
            json!({"floor_id":"A","x":0,"y":1,"block_id":"a_later","numeric_id":2,"kind":"transition",
                "target":{"floor_id":"B","x":0,"y":0}}),
        ];
        if include_cycle {
            blocks.push(json!({"floor_id":"A","x":1,"y":1,"block_id":"loop","numeric_id":3,"kind":"transition",
                "target":{"floor_id":"A","x":0,"y":0}}));
        }
        json!({
            "session_id":"S","floor_id":"A","map_instance_id":"M",
            "dimensions":{"width":2,"height":2},"topology":{"kind":"rectangle"},
            "hero":{"hp":10,"attack":1,"defense":1,"gold":0,"experience":0,"loc":{"x":0,"y":0}},
            "keys":{"yellow":0,"blue":0,"red":0},"blocks":[],
            "engine_model":{"inventory":{"classes":{}},"solver_model":{
                "protocol":1,"search_budget":16,"terminal":{"kind":"location","floor_id":"B","x":0,"y":0},
                "blockers":[],"shops":[],
                "floors":[
                    {"floor_id":"A","width":2,"height":2,"topology":{"kind":"rectangle"},"blocks":blocks},
                    {"floor_id":"B","width":1,"height":1,"topology":{"kind":"rectangle"},"blocks":[]}
                ]
            }}
        })
    }

    #[test]
    fn valid_cycle_is_idle_and_read_only() {
        let state = Mutex::new(ShadowState::default());
        let response = shadow_response(&request(), &state).expect("valid request");
        assert_eq!(response["status"], "idle");
        assert_eq!(response["shadow"]["mode"], "read_only");
        assert_eq!(response["shadow"]["cycle"], 1);
        assert_eq!(
            response["shadow"]["analysis"]["scope"],
            "current_floor_immediate"
        );
        assert!(response.get("action_id").is_none());
        assert!(response.get("operations").is_none());
    }

    #[test]
    fn global_route_replays_resource_fight_transition_door_and_terminal() {
        let response = shadow_response(
            &request_with(global_observation(None)),
            &Mutex::new(ShadowState::default()),
        )
        .unwrap();
        let global = &response["shadow"]["analysis"]["global"];
        assert_eq!(global["proof"], "proven");
        assert_eq!(global["terminal_hp"], 19.0);
        assert_eq!(global["terminal_attack"], 15.0);
        assert_eq!(global["terminal_defense"], 5.0);
        let kinds: Vec<_> = global["route"]["steps"]
            .as_array()
            .unwrap()
            .iter()
            .map(|step| step["step_kind"].as_str().unwrap())
            .collect();
        assert_eq!(
            kinds,
            vec![
                "resource",
                "enemy",
                "transition",
                "enemy",
                "resource",
                "shop",
                "enemy",
                "door",
                "terminal"
            ]
        );
        assert_eq!(global["first_suggestion"]["step_kind"], "resource");
        assert!(
            !global["route"]["steps"]
                .as_array()
                .unwrap()
                .iter()
                .any(|step| step["block_id"] == "jackpot"),
            "a locally valuable branch that consumes the only terminal key is rejected"
        );
        let serialized = serde_json::to_string(global).unwrap();
        for forbidden in [
            "\"action\":",
            "\"execute\":",
            "\"operation\":",
            "\"guard\":",
        ] {
            assert!(!serialized.contains(forbidden));
        }
    }

    #[test]
    fn phase2_recovers_lexically_smallest_witness_after_phase1_fifo_same_state_tie() {
        let observation = fifo_same_state_tie_observation(false);
        let (global, stats) = global_analysis_with_stats(observation.as_object().unwrap());
        assert_eq!(global["proof"], "proven");
        assert_eq!(global["route"]["steps"][0]["block_id"], "a_later");
        assert!(stats.phase_a_explored > 0);
        assert!(stats.phase_b_explored > 0);
        PHASE2_SAW_PHASE_A_DROPPED.with(|seen| assert!(seen.get()));
    }

    #[test]
    fn state_simple_witness_rejects_a_strategic_cycle_without_changing_canonical_route() {
        let observation = fifo_same_state_tie_observation(true);
        let (global, stats) = global_analysis_with_stats(observation.as_object().unwrap());
        assert_eq!(global["proof"], "proven");
        let ids: Vec<_> = global["route"]["steps"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|step| step["block_id"].as_str())
            .collect();
        assert_eq!(ids, vec!["a_later"]);
        assert_eq!(
            stats.phase_b_explored, 2,
            "the root and canonical target only"
        );
    }

    #[test]
    fn two_phase_stats_keep_protocol_count_at_phase_a_and_record_phase_b_privately() {
        let exhausted = two_terminal_routes(2);
        let (global, stats) = global_analysis_with_stats(exhausted.as_object().unwrap());
        assert_eq!(global["proof"], "unproven");
        assert_eq!(
            global["explored_states"].as_u64().unwrap() as usize,
            stats.phase_a_explored
        );
        assert_eq!(stats.phase_b_explored, 0);
    }

    #[test]
    fn global_route_fails_closed_for_unknown_blocker_but_not_known_walls() {
        let wall_only = shadow_response(
            &request_with(global_observation(None)),
            &Mutex::new(ShadowState::default()),
        )
        .unwrap();
        assert_eq!(wall_only["shadow"]["analysis"]["global"]["proof"], "proven");

        let mut unknown = global_observation(None);
        unknown["engine_model"]["solver_model"]["terminal"] =
            json!({"kind":"location","floor_id":"F1","x":0,"y":0});
        unknown["engine_model"]["solver_model"]["floors"][0]["blocks"]
            .as_array_mut()
            .unwrap()
            .push(json!({"floor_id":"F1","x":0,"y":0,"block_id":"opaqueEvent",
                "numeric_id":99,"kind":"opaque","reason":"event_unsupported"}));
        unknown["engine_model"]["solver_model"]["blockers"] =
            json!([{"code":"EVENT_UNSUPPORTED","detail":"F1:0,0"}]);
        let response =
            shadow_response(&request_with(unknown), &Mutex::new(ShadowState::default())).unwrap();
        let global = &response["shadow"]["analysis"]["global"];
        assert_eq!(global["proof"], "unsupported");
        assert_eq!(global["truncated"], false);
        assert_eq!(global["route"], Value::Null);
        assert_eq!(global["first_suggestion"], Value::Null);
        assert!(global.get("terminal_hp").is_none());
        assert!(global.get("terminal_attack").is_none());
        assert!(global.get("terminal_defense").is_none());
        assert_eq!(global["blockers"][0]["code"], "EVENT_UNSUPPORTED");
    }

    #[test]
    fn terminal_parse_failure_preserves_source_blockers() {
        let mut observation = global_observation(None);
        observation["engine_model"]["solver_model"]["terminal"] = Value::Null;
        observation["engine_model"]["solver_model"]["blockers"] = json!([{"code":"TERMINAL_UNSUPPORTED","detail":"expected_one_goal:0"},
                {"code":"RESOURCE_UNSUPPORTED","detail":"wand"}]);
        let response = shadow_response(
            &request_with(observation),
            &Mutex::new(ShadowState::default()),
        )
        .unwrap();
        let global = &response["shadow"]["analysis"]["global"];
        assert_eq!(global["proof"], "unsupported");
        assert_eq!(global["reason"], "terminal_unsupported");
        assert_eq!(global["explored_states"], 0);
        assert_eq!(global["blockers"].as_array().unwrap().len(), 2);
        assert_eq!(global["blockers"][0]["code"], "TERMINAL_UNSUPPORTED");
    }

    #[test]
    fn any_explicit_terminal_location_can_complete_the_route() {
        let mut observation = global_observation(None);
        observation["engine_model"]["solver_model"]["terminal"] = json!({
            "kind":"any_location","locations":[
                {"kind":"location","floor_id":"unreachable","x":0,"y":0},
                {"kind":"location","floor_id":"F2","x":4,"y":0}
            ]
        });
        let response = shadow_response(
            &request_with(observation),
            &Mutex::new(ShadowState::default()),
        )
        .unwrap();
        let global = &response["shadow"]["analysis"]["global"];
        assert_eq!(global["proof"], "proven");
        assert_eq!(
            global["route"]["steps"].as_array().unwrap().last().unwrap()["floor_id"],
            "F2"
        );
    }

    #[test]
    fn all_reachable_terminals_choose_the_same_lexical_result_independent_of_input_order() {
        let reverse = shadow_response(
            &request_with(any_location_terminal_observation(&[(2, 0), (0, 0)])),
            &Mutex::new(ShadowState::default()),
        )
        .unwrap();
        let forward = shadow_response(
            &request_with(any_location_terminal_observation(&[(0, 0), (2, 0)])),
            &Mutex::new(ShadowState::default()),
        )
        .unwrap();
        for response in [&reverse, &forward] {
            let global = &response["shadow"]["analysis"]["global"];
            assert_eq!(global["proof"], "proven");
            assert_eq!(global["route"]["steps"].as_array().unwrap().len(), 1);
            assert_eq!(global["route"]["steps"][0]["step_kind"], "terminal");
            assert_eq!(global["route"]["steps"][0]["x"], 0);
        }
        assert_eq!(
            reverse["shadow"]["analysis"]["global"],
            forward["shadow"]["analysis"]["global"]
        );
    }

    #[test]
    fn phase2_budget_exhaustion_uses_the_protocol_search_budget_reason() {
        let response = shadow_response(
            &request_with(phase2_budget_response_observation()),
            &Mutex::new(ShadowState::default()),
        )
        .unwrap();
        let global = &response["shadow"]["analysis"]["global"];
        assert_eq!(global["proof"], "unproven");
        assert_eq!(global["reason"], "search_budget_exhausted");
        assert_eq!(global["truncated"], true);
        assert_eq!(global["route"], Value::Null);
        assert_eq!(global["first_suggestion"], Value::Null);
    }

    #[test]
    fn global_search_budget_exhaustion_is_unproven_and_deterministic() {
        PHASE2_CALLS.with(|calls| calls.set(0));
        for budget in [2, 3] {
            let request = request_with(two_terminal_routes(budget));
            let first = shadow_response(&request, &Mutex::new(ShadowState::default())).unwrap();
            let second = shadow_response(&request, &Mutex::new(ShadowState::default())).unwrap();
            let global = &first["shadow"]["analysis"]["global"];
            assert_eq!(
                global["proof"], "unproven",
                "budget={budget} global={global}"
            );
            assert_eq!(global["reason"], "search_budget_exhausted");
            assert_eq!(global["route"], Value::Null);
            assert_eq!(global["first_suggestion"], Value::Null);
            assert!(global.get("terminal_hp").is_none());
            assert!(global.get("terminal_attack").is_none());
            assert!(global.get("terminal_defense").is_none());
            assert_eq!(global, &second["shadow"]["analysis"]["global"]);
        }
        PHASE2_CALLS.with(|calls| assert_eq!(calls.get(), 0));
        // Terminal observations now keep expanding same-region candidates, so this complete
        // fixture needs one additional pop after the terminal branch is recorded.
        let complete = shadow_response(
            &request_with(two_terminal_routes(5)),
            &Mutex::new(ShadowState::default()),
        )
        .unwrap();
        assert_eq!(complete["shadow"]["analysis"]["global"]["proof"], "proven");
        assert_eq!(
            complete["shadow"]["analysis"]["global"]["terminal_hp"],
            21.0
        );
        assert_eq!(
            complete["shadow"]["analysis"]["global"]["terminal_attack"],
            1.0
        );
        assert_eq!(
            complete["shadow"]["analysis"]["global"]["terminal_defense"],
            1.0
        );
    }

    #[test]
    fn global_shop_purchase_count_is_part_of_state_and_allows_repeated_choices() {
        let mut observation = global_observation(None);
        observation["engine_model"]["solver_model"]["floors"][0]["blocks"][0]["delta"]["gold"] =
            json!(30);
        observation["engine_model"]["solver_model"]["floors"][1]["blocks"][1]["enemy"]["defense"] =
            json!(17);
        let choice = &mut observation["engine_model"]["solver_model"]["shops"][0]["choices"][0];
        choice["base_cost"] = json!(5);
        choice["increment_per_purchase"] = json!(5);
        choice["purchase_count"] = json!(1);
        choice["cost"] = json!(10);
        let response = shadow_response(
            &request_with(observation),
            &Mutex::new(ShadowState::default()),
        )
        .unwrap();
        let global = &response["shadow"]["analysis"]["global"];
        assert_eq!(global["proof"], "proven");
        let shop_steps: Vec<_> = global["route"]["steps"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|step| step["step_kind"] == "shop")
            .collect();
        assert_eq!(shop_steps.len(), 2);
        assert_eq!(shop_steps[0]["details"]["purchase_count_before"], 1);
        assert_eq!(shop_steps[0]["details"]["cost"], 10);
        assert_eq!(shop_steps[1]["details"]["purchase_count_before"], 2);
        assert_eq!(shop_steps[1]["details"]["cost"], 15);
    }

    #[test]
    fn current_floor_candidates_have_immediate_costs_and_stop_at_boundaries() {
        let request = request_with(json!({
            "session_id": "S", "floor_id": "F", "map_instance_id": "M",
            "dimensions": {"width": 5, "height": 5},
            "topology": {"kind": "rectangle"},
            "hero": {"hp": 25, "loc": {"x": 2, "y": 2}},
            "keys": {"yellow": 1, "blue": 0, "red": 0},
            "blocks": [
                {"x": 3, "y": 2, "numeric_id": 101, "id": "slime", "trigger": "battle", "no_pass": true, "damage": 7, "enemy": {"hp": 10}},
                {"x": 2, "y": 1, "numeric_id": 102, "id": "blueDoor", "trigger": "openDoor", "no_pass": true, "damage": null, "enemy": null},
                {"x": 2, "y": 3, "numeric_id": 103, "id": "redGem", "trigger": "getItem", "no_pass": false, "damage": null, "enemy": null},
                {"x": 1, "y": 2, "numeric_id": 104, "id": "upFloor", "trigger": "changeFloor", "no_pass": false, "damage": null, "enemy": null},
                {"x": 4, "y": 2, "numeric_id": 105, "id": "hiddenEnemy", "trigger": "battle", "no_pass": true, "damage": null, "enemy": {"hp": 10}}
            ]
        }));
        let response = shadow_response(&request, &Mutex::new(ShadowState::default())).unwrap();
        let candidates = response["shadow"]["analysis"]["candidates"]
            .as_array()
            .unwrap();
        assert_eq!(
            candidates.len(),
            4,
            "enemy behind a boundary is not reachable"
        );
        assert_eq!(candidates[0]["kind"], "door");
        assert_eq!(candidates[0]["feasibility"], "missing_key");
        assert_eq!(candidates[0]["key_cost"]["blue"], 1);
        assert_eq!(candidates[1]["kind"], "stair");
        assert_eq!(candidates[2]["kind"], "enemy");
        assert_eq!(candidates[2]["hp_loss"], 7);
        assert_eq!(candidates[2]["feasibility"], "known_feasible");
        assert_eq!(candidates[3]["kind"], "resource");
        assert!(
            candidates
                .iter()
                .all(|candidate| candidate["distance"] == 1)
        );
    }

    #[test]
    fn enemy_feasibility_distinguishes_lethal_and_unknown_cost() {
        let request = request_with(json!({
            "session_id": "S", "floor_id": "F", "map_instance_id": "M",
            "dimensions": {"width": 3, "height": 3},
            "topology": {"kind": "rectangle"},
            "hero": {"hp": 10, "loc": {"x": 1, "y": 1}},
            "keys": {"yellow": 0, "blue": 0, "red": 0},
            "blocks": [
                {"x": 0, "y": 1, "numeric_id": 1, "id": "unknown", "trigger": "battle", "no_pass": true, "damage": "???", "enemy": {"hp": 10}},
                {"x": 2, "y": 1, "numeric_id": 2, "id": "lethal", "trigger": "battle", "no_pass": true, "damage": 10, "enemy": {"hp": 10}}
            ]
        }));
        let response = shadow_response(&request, &Mutex::new(ShadowState::default())).unwrap();
        let candidates = response["shadow"]["analysis"]["candidates"]
            .as_array()
            .unwrap();
        assert_eq!(candidates[0]["feasibility"], "unknown_cost");
        assert!(candidates[0]["hp_loss"].is_null());
        assert_eq!(candidates[1]["feasibility"], "known_lethal");
        assert_eq!(candidates[1]["hp_loss"], 10);
    }

    #[test]
    fn walls_and_unhandled_boundaries_block_candidates_behind_them() {
        for blocker in [
            json!({"x": 2, "y": 0, "numeric_id": 1, "id": "wall", "trigger": null, "no_pass": true, "damage": null, "enemy": null}),
            json!({"x": 2, "y": 0, "numeric_id": 2, "id": "opaqueEvent", "trigger": "customEvent", "no_pass": false, "damage": null, "enemy": null}),
        ] {
            let request = request_with(json!({
                "session_id": "S", "floor_id": "F", "map_instance_id": "M",
                "dimensions": {"width": 5, "height": 1},
                "topology": {"kind": "rectangle"},
                "hero": {"hp": 10, "loc": {"x": 0, "y": 0}},
                "keys": {"yellow": 0, "blue": 0, "red": 0},
                "blocks": [
                    blocker,
                    {"x": 3, "y": 0, "numeric_id": 3, "id": "hiddenGem", "trigger": "getItem", "no_pass": false, "damage": null, "enemy": null}
                ]
            }));
            let response = shadow_response(&request, &Mutex::new(ShadowState::default())).unwrap();
            assert_eq!(response["shadow"]["analysis"]["reachable_cell_count"], 2);
            assert_eq!(response["shadow"]["analysis"]["total_candidate_count"], 0);
        }
    }

    #[test]
    fn analysis_is_deterministic_and_bounded() {
        let blocks: Vec<Value> = (0..256_u64)
            .flat_map(|x| {
                [0_u64, 2_u64].map(move |y| {
                    json!({
                        "x": x, "y": y, "numeric_id": x * 2 + y + 1,
                        "id": format!("item{x}-{y}"), "trigger": "getItem",
                        "no_pass": false, "damage": null, "enemy": null
                    })
                })
            })
            .collect();
        let request = request_with(json!({
            "session_id": "S", "floor_id": "F", "map_instance_id": "M",
            "dimensions": {"width": 256, "height": 3},
            "topology": {"kind": "rectangle"},
            "hero": {"hp": 10, "loc": {"x": 0, "y": 1}},
            "keys": {"yellow": 0, "blue": 0, "red": 0},
            "blocks": blocks
        }));
        let first = shadow_response(&request, &Mutex::new(ShadowState::default())).unwrap();
        let second = shadow_response(&request, &Mutex::new(ShadowState::default())).unwrap();
        assert_eq!(first["shadow"]["analysis"], second["shadow"]["analysis"]);
        assert_eq!(first["shadow"]["analysis"]["candidate_limit"], 256);
        assert_eq!(first["shadow"]["analysis"]["total_candidate_count"], 512);
        assert_eq!(first["shadow"]["analysis"]["truncated"], true);
        assert_eq!(
            first["shadow"]["analysis"]["candidates"]
                .as_array()
                .unwrap()
                .len(),
            256
        );
    }

    #[test]
    fn cycles_are_process_local_and_monotonic() {
        let state = Mutex::new(ShadowState::default());
        assert_eq!(
            shadow_response(&request(), &state).unwrap()["shadow"]["cycle"],
            1
        );
        assert_eq!(
            shadow_response(&request(), &state).unwrap()["shadow"]["cycle"],
            2
        );
    }

    #[test]
    fn malformed_request_is_rejected() {
        let state = Mutex::new(ShadowState::default());
        let error = shadow_response(br#"{}"#, &state).expect_err("invalid request");
        assert_eq!(error["status"], "error");
        assert_eq!(error["error_code"], "INVALID_REQUEST");
    }

    #[test]
    fn actual_idle_shadow_response_matches_draft_2020_12_schema() {
        let schema: Value =
            serde_json::from_str(include_str!("../../../protocol/cycle-response.schema.json"))
                .expect("response schema JSON");
        let validator = jsonschema::validator_for(&schema).expect("Draft 2020-12 response schema");
        let state = Mutex::new(ShadowState::default());
        let response =
            shadow_response(&request(), &state).expect("actual successful Rust response");
        assert!(
            validator.validate(&response).is_ok(),
            "actual idle + shadow response must satisfy the JSON Schema"
        );
    }

    #[test]
    fn execute_response_with_shadow_is_rejected_by_draft_2020_12_schema() {
        let schema: Value =
            serde_json::from_str(include_str!("../../../protocol/cycle-response.schema.json"))
                .expect("response schema JSON");
        let validator = jsonschema::validator_for(&schema).expect("Draft 2020-12 response schema");
        let mut execute: Value = serde_json::from_str(include_str!(
            "../../../tests/fixtures/protocol-responses.json"
        ))
        .expect("execute fixture");
        let execute = execute
            .get_mut("execute")
            .and_then(Value::as_object_mut)
            .expect("execute fixture object");
        execute.insert(
            "shadow".to_owned(),
            json!({"mode": "read_only", "reason": "idle only", "cycle": 1}),
        );
        assert!(
            validator.validate(&Value::Object(execute.clone())).is_err(),
            "execute must reject the idle-only shadow field"
        );
    }
}
