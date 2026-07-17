use serde_json::{Value, json};
use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
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
}

#[derive(Clone, Debug)]
struct SolverFloor {
    width: u64,
    height: u64,
    cells: HashSet<(u64, u64)>,
    blocks: Vec<usize>,
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
    consumed: Arc<Vec<bool>>,
    shop_counts: Arc<Vec<u64>>,
    flags: Arc<Vec<(String, u64)>>,
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
struct StructuralKey {
    floor: String,
    x: u64,
    y: u64,
    inventory: Arc<Vec<(String, u64)>>,
    consumed: Arc<Vec<bool>>,
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

struct RouteLink {
    parent: Option<usize>,
    action: Option<RouteAction>,
}

#[derive(Clone)]
struct SearchNode {
    state: SolverState,
    parent: Option<usize>,
    action: Option<RouteAction>,
    depth: usize,
}

struct TerminalRoute {
    state: SolverState,
    steps: Vec<Value>,
}

fn route_action_json(action: &RouteAction, blocks: &[SolverBlock]) -> Value {
    match action {
        RouteAction::Block { index, action } => {
            let block = &blocks[*index];
            let (kind, details) = match action {
                BlockRouteAction::Door { yellow, blue, red } => (
                    "door",
                    json!({"key_cost":{"yellow":yellow,"blue":blue,"red":red}}),
                ),
                BlockRouteAction::Resource => ("resource", block.data["delta"].clone()),
                BlockRouteAction::Enemy { hp_loss } => ("enemy", json!({"hp_loss":hp_loss.get()})),
                BlockRouteAction::Transition => ("transition", json!({})),
                BlockRouteAction::Event { event_id } => ("event", json!({"event_id":event_id})),
            };
            step_json(kind, block, details)
        }
        RouteAction::Shop {
            floor,
            shop_id,
            choice_id,
            currency,
            cost,
            purchase_count_before,
            effects,
        } => json!({"step_kind":"shop","floor_id":floor,"shop_id":shop_id,
            "choice_id":choice_id,"details":{"currency":currency,"cost":cost,
            "purchase_count_before":purchase_count_before,"effects":effects.iter()
                .map(|effect| json!({"field":effect.field,"amount":effect.amount})).collect::<Vec<_>>()}}),
    }
}

fn reconstruct_steps(arena: &[RouteLink], mut index: usize, blocks: &[SolverBlock]) -> Vec<Value> {
    let mut actions = Vec::new();
    loop {
        let link = &arena[index];
        if let Some(action) = &link.action {
            actions.push(route_action_json(action, blocks));
        }
        match link.parent {
            Some(parent) => index = parent,
            None => break,
        }
    }
    actions.reverse();
    actions
}

fn terminal_route_is_better(candidate: &TerminalRoute, current: &TerminalRoute) -> bool {
    let score = |node: &TerminalRoute| {
        (
            node.state.attack.get() + node.state.defense.get(),
            node.state.attack.get().min(node.state.defense.get()),
            node.state.hp.get(),
        )
    };
    let left = score(candidate);
    let right = score(current);
    let ordering = left
        .0
        .total_cmp(&right.0)
        .then(left.1.total_cmp(&right.1))
        .then(left.2.total_cmp(&right.2));
    ordering.is_gt()
        || (ordering.is_eq()
            && serde_json::to_string(&candidate.steps).unwrap()
                < serde_json::to_string(&current.steps).unwrap())
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
    Ok((floors, blocks, terminal, shops, blockers))
}

fn reachable_cells(
    state: &SolverState,
    floors: &HashMap<String, SolverFloor>,
    blocks: &[SolverBlock],
) -> HashSet<(u64, u64)> {
    let Some(floor) = floors.get(&state.floor) else {
        return HashSet::new();
    };
    let blocked: HashSet<(u64, u64)> = floor
        .blocks
        .iter()
        .filter_map(|index| {
            let block = &blocks[*index];
            let consumed = state.consumed.get(*index).copied().unwrap_or(false);
            (!consumed && block.kind != "terrain" && block.kind != "shop")
                .then_some((block.x, block.y))
        })
        .collect();
    let mut seen = HashSet::from([(state.x, state.y)]);
    let mut queue = VecDeque::from([(state.x, state.y)]);
    while let Some((x, y)) = queue.pop_front() {
        for (dx, dy) in [(0_i64, -1_i64), (-1, 0), (1, 0), (0, 1)] {
            let nx = x as i64 + dx;
            let ny = y as i64 + dy;
            if nx < 0 || ny < 0 {
                continue;
            }
            let position = (nx as u64, ny as u64);
            if position.0 >= floor.width
                || position.1 >= floor.height
                || !floor.cells.contains(&position)
                || blocked.contains(&position)
            {
                continue;
            }
            if seen.insert(position) {
                queue.push_back(position);
            }
        }
    }
    seen
}

fn adjacent(reachable: &HashSet<(u64, u64)>, x: u64, y: u64) -> bool {
    [(0_i64, -1_i64), (-1, 0), (1, 0), (0, 1)]
        .iter()
        .any(|(dx, dy)| {
            let nx = x as i64 + dx;
            let ny = y as i64 + dy;
            nx >= 0 && ny >= 0 && reachable.contains(&(nx as u64, ny as u64))
        })
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

fn step_json(kind: &str, block: &SolverBlock, details: Value) -> Value {
    json!({"step_kind":kind,"floor_id":block.floor,"x":block.x,"y":block.y,
        "block_id":block.id,"details":details})
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

fn set_consumed(state: &mut SolverState, index: usize, value: bool) {
    Arc::make_mut(&mut state.consumed)[index] = value;
}

fn consume_at(state: &mut SolverState, blocks: &[SolverBlock], floor: &str, x: u64, y: u64) {
    for (index, block) in blocks.iter().enumerate() {
        if block.floor == floor && block.x == x && block.y == y {
            set_consumed(state, index, true);
        }
    }
}

fn activate_at(state: &mut SolverState, blocks: &[SolverBlock], floor: &str, x: u64, y: u64) {
    for (index, block) in blocks.iter().enumerate() {
        if block.floor == floor && block.x == x && block.y == y {
            set_consumed(state, index, false);
        }
    }
}

fn replace_at(
    state: &mut SolverState,
    blocks: &[SolverBlock],
    floor: &str,
    x: u64,
    y: u64,
    numeric_id: u64,
) -> bool {
    let mut replacement = None;
    for (index, block) in blocks.iter().enumerate() {
        if block.floor == floor && block.x == x && block.y == y {
            set_consumed(state, index, true);
            if block.data.get("numeric_id").and_then(Value::as_u64) == Some(numeric_id) {
                replacement = Some(index);
            }
        }
    }
    if let Some(index) = replacement {
        set_consumed(state, index, false);
        true
    } else {
        false
    }
}

fn apply_audited_event(
    state: &mut SolverState,
    block: &SolverBlock,
    block_index: usize,
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
                set_consumed(state, block_index, true);
                activate_at(state, blocks, "MT20", 6, 8);
            } else {
                return None;
            }
        }
        "book_reward" => {
            add_item(state, "book", 1);
            set_consumed(state, block_index, true);
        }
        "sword2_reward" => {
            state.attack = state.attack.add(70.0)?;
            set_consumed(state, block_index, true);
        }
        "shield2_reward" => {
            state.defense = state.defense.add(30.0)?;
            set_consumed(state, block_index, true);
        }
        "cross_reward" => {
            add_item(state, "cross", 1);
            set_consumed(state, block_index, true);
            consume_at(state, blocks, "MT16", 5, 5);
        }
        "fly_reward" => {
            add_item(state, "fly", 1);
            state_set(&mut state.flags, "fly", 1);
            set_consumed(state, block_index, true);
        }
        "ice_pickaxe_reward" => {
            add_item(state, "icePickaxe", 1);
            set_consumed(state, block_index, true);
        }
        "exp_sword_trade" => {
            if state.experience < 500 {
                return None;
            }
            state.experience -= 500;
            state.attack = state.attack.add(120.0)?;
            set_consumed(state, block_index, true);
        }
        "gold_shield_trade" => {
            if state.gold < 500 {
                return None;
            }
            state.gold -= 500;
            state.defense = state.defense.add(120.0)?;
            set_consumed(state, block_index, true);
        }
        "ice_wand_reward" => {
            state_set(&mut state.flags, "16", 1);
            set_consumed(state, block_index, true);
        }
        "dialogue_once" => {
            set_consumed(state, block_index, true);
        }
        "thief_quest" => {
            if state_count(&state.flags, "switch:MT4:6,1:A") == 0 {
                state_set(&mut state.flags, "switch:MT4:6,1:A", 1);
                consume_at(state, blocks, "MT2", 2, 7);
            } else if consume_item(state, "icePickaxe", 1) {
                consume_at(state, blocks, "MT18", 6, 9);
                consume_at(state, blocks, "MT18", 6, 10);
                set_consumed(state, block_index, true);
            } else {
                return None;
            }
        }
        "princess_quest" => {
            if state_count(&state.flags, "switch:MT18:6,5:A") > 0 {
                return None;
            }
            state_set(&mut state.flags, "switch:MT18:6,5:A", 1);
            activate_at(state, blocks, "MT18", 11, 11);
        }
        "wand_gate_remove_on_failure" | "wand_gate_retry" => {
            let missing = blocks.iter().enumerate().any(|(index, candidate)| {
                ((candidate.floor == "MT23w" && candidate.x == 5 && candidate.y == 6)
                    || (candidate.floor == "MT23e" && candidate.x == 7 && candidate.y == 6))
                    && !state.consumed[index]
            });
            if missing {
                if id == "wand_gate_remove_on_failure" {
                    set_consumed(state, block_index, true);
                } else {
                    return None;
                }
            } else {
                state_set(&mut state.flags, "final_wand_gate", 1);
                set_consumed(state, block_index, true);
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

fn global_analysis(observation: &serde_json::Map<String, Value>) -> Value {
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
    let Ok((floors, blocks, terminal, shops, blockers)) = parsed else {
        return json!({"scope":"global_terminal_route","proof":"unsupported","reason":parsed.unwrap_err(),
            "truncated":false,"explored_states":0,"blockers":source_blockers,"route":null,"first_suggestion":null});
    };
    if !blockers.is_empty() {
        return json!({"scope":"global_terminal_route","proof":"unsupported","reason":"unsupported_solver_blocker",
            "truncated":false,"explored_states":0,"blockers":blockers,"route":null,"first_suggestion":null});
    }
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
        consumed: Arc::new(
            blocks
                .iter()
                .map(|block| {
                    block.data.get("initial_active").and_then(Value::as_bool) == Some(false)
                })
                .collect(),
        ),
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
    let mut queue = VecDeque::from([SearchNode {
        state: initial,
        parent: None,
        action: None,
        depth: 0,
    }]);
    let mut route_arena = Vec::new();
    let mut seen = HashSet::new();
    let mut dominance: HashMap<StructuralKey, Vec<[f64; 8]>> = HashMap::new();
    let mut explored = 0usize;
    let mut best: Option<TerminalRoute> = None;
    let mut budget_exhausted = false;
    while let Some(node) = queue.pop_front() {
        if explored >= max_states {
            budget_exhausted = true;
            break;
        }
        if !seen.insert(node.state.clone()) {
            continue;
        }
        let structural = StructuralKey::from(&node.state);
        let resources = [
            node.state.hp.get(),
            node.state.attack.get(),
            node.state.defense.get(),
            node.state.gold as f64,
            node.state.experience as f64,
            node.state.yellow as f64,
            node.state.blue as f64,
            node.state.red as f64,
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
        let route_index = route_arena.len();
        route_arena.push(RouteLink {
            parent: node.parent,
            action: node.action.clone(),
        });
        let reachable = reachable_cells(&node.state, &floors, &blocks);
        if let Some((terminal_floor, terminal_pos)) = terminals
            .iter()
            .find(|(floor, position)| node.state.floor == *floor && reachable.contains(position))
        {
            let mut steps = reconstruct_steps(&route_arena, route_index, &blocks);
            steps.push(json!({"step_kind":"terminal","floor_id":terminal_floor,"x":terminal_pos.0,"y":terminal_pos.1,"details":{}}));
            let won = TerminalRoute {
                state: node.state.clone(),
                steps,
            };
            if best
                .as_ref()
                .is_none_or(|old| terminal_route_is_better(&won, old))
            {
                best = Some(won);
            }
            continue;
        }
        for (index, block) in blocks.iter().enumerate() {
            if block.floor != node.state.floor
                || node.state.consumed[index]
                || block.kind == "opaque"
                || block.kind == "terrain"
                || !adjacent(&reachable, block.x, block.y)
            {
                continue;
            }
            let mut next = SearchNode {
                state: node.state.clone(),
                parent: Some(route_index),
                action: None,
                depth: node.depth + 1,
            };
            match block.kind.as_str() {
                "door" => {
                    let cost = &block.data["key_cost"];
                    let (y, b, r) = (
                        cost["yellow"].as_u64().unwrap_or(0),
                        cost["blue"].as_u64().unwrap_or(0),
                        cost["red"].as_u64().unwrap_or(0),
                    );
                    if next.state.yellow < y || next.state.blue < b || next.state.red < r {
                        continue;
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
                        continue;
                    }
                    next.state.yellow -= y;
                    next.state.blue -= b;
                    next.state.red -= r;
                    if let Some(costs) = inventory_cost {
                        for (id, count) in costs {
                            *inventory.entry(id.clone()).or_default() -= count.as_u64().unwrap();
                        }
                    }
                    next.state.inventory = Arc::new(
                        inventory
                            .into_iter()
                            .filter(|(_, count)| *count > 0)
                            .collect(),
                    );
                    set_consumed(&mut next.state, index, true);
                    next.action = Some(RouteAction::Block {
                        index,
                        action: BlockRouteAction::Door {
                            yellow: y,
                            blue: b,
                            red: r,
                        },
                    });
                }
                "resource" => {
                    if add_delta(&mut next.state, &block.data["delta"]).is_err() {
                        continue;
                    }
                    set_consumed(&mut next.state, index, true);
                    next.action = Some(RouteAction::Block {
                        index,
                        action: BlockRouteAction::Resource,
                    });
                }
                "enemy" => {
                    let Some(loss) = enemy_loss(&next.state, &block.data["enemy"]) else {
                        continue;
                    };
                    if loss >= next.state.hp.get() {
                        continue;
                    }
                    next.state.hp = F64Bits::new(next.state.hp.get() - loss).unwrap();
                    next.state.gold += block.data["enemy"]["gold"].as_u64().unwrap_or(0);
                    next.state.experience +=
                        block.data["enemy"]["experience"].as_u64().unwrap_or(0);
                    set_consumed(&mut next.state, index, true);
                    next.action = Some(RouteAction::Block {
                        index,
                        action: BlockRouteAction::Enemy {
                            hp_loss: F64Bits::new(loss).unwrap(),
                        },
                    });
                }
                "transition" => {
                    let target = &block.data["target"];
                    next.state.floor = target["floor_id"].as_str().unwrap_or_default().to_owned();
                    next.state.x = target["x"].as_u64().unwrap_or(0);
                    next.state.y = target["y"].as_u64().unwrap_or(0);
                    next.action = Some(RouteAction::Block {
                        index,
                        action: BlockRouteAction::Transition,
                    });
                }
                "event" => {
                    let Some(event_details) =
                        apply_audited_event(&mut next.state, block, index, &blocks)
                    else {
                        continue;
                    };
                    next.action = Some(RouteAction::Block {
                        index,
                        action: BlockRouteAction::Event {
                            event_id: event_details["event_id"]
                                .as_str()
                                .unwrap_or_default()
                                .to_owned(),
                        },
                    });
                }
                _ => continue,
            }
            queue.push_back(next);
        }
        // A restricted shop can be used whenever its bound block is adjacent. Each purchase is a separate state.
        let mut choice_offset = 0usize;
        for shop in &shops {
            let shop_id = shop
                .get("shop_id")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let accessible = blocks.iter().any(|block| {
                block.floor == node.state.floor
                    && block.kind == "shop"
                    && block.data.get("shop_id").and_then(Value::as_str) == Some(shop_id)
                    && adjacent(&reachable, block.x, block.y)
            });
            let choices = shop
                .get("choices")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            if accessible {
                for (local, choice) in choices.iter().enumerate() {
                    let purchase_count = node.state.shop_counts[choice_offset + local];
                    let Some(cost) = choice["base_cost"].as_u64().and_then(|base| {
                        choice["increment_per_purchase"]
                            .as_u64()
                            .and_then(|increment| {
                                increment
                                    .checked_mul(purchase_count)
                                    .and_then(|extra| base.checked_add(extra))
                            })
                    }) else {
                        continue;
                    };
                    let mut next = SearchNode {
                        state: node.state.clone(),
                        parent: Some(route_index),
                        action: None,
                        depth: node.depth + 1,
                    };
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
                        _ => continue,
                    };
                    if balance < cost {
                        continue;
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
                    let mut valid = true;
                    for effect in &effects {
                        let field = effect["field"].as_str().unwrap_or_default();
                        let amount = effect["amount"].as_u64().unwrap_or(0);
                        match field {
                            "level" => next.state.level = next.state.level.saturating_add(amount),
                            "hp" => next.state.hp = next.state.hp.add(amount as f64).unwrap(),
                            "attack" => {
                                next.state.attack = next.state.attack.add(amount as f64).unwrap()
                            }
                            "defense" => {
                                next.state.defense = next.state.defense.add(amount as f64).unwrap()
                            }
                            "gold" => next.state.gold = next.state.gold.saturating_add(amount),
                            "experience" => {
                                next.state.experience = next.state.experience.saturating_add(amount)
                            }
                            "yellow" => {
                                next.state.yellow = next.state.yellow.saturating_add(amount)
                            }
                            "blue" => next.state.blue = next.state.blue.saturating_add(amount),
                            "red" => next.state.red = next.state.red.saturating_add(amount),
                            _ => {
                                valid = false;
                                break;
                            }
                        }
                    }
                    if !valid {
                        continue;
                    }
                    Arc::make_mut(&mut next.state.shop_counts)[choice_offset + local] += 1;
                    next.action = Some(RouteAction::Shop {
                        floor: node.state.floor.clone(),
                        shop_id: shop_id.to_owned(),
                        choice_id: choice["choice_id"].as_str().unwrap_or_default().to_owned(),
                        currency: currency.to_owned(),
                        cost,
                        purchase_count_before: purchase_count,
                        effects: effects
                            .iter()
                            .map(|effect| ShopRouteEffect {
                                field: effect["field"].as_str().unwrap_or_default().to_owned(),
                                amount: effect["amount"].as_u64().unwrap_or(0),
                            })
                            .collect(),
                    });
                    queue.push_back(next);
                }
            }
            choice_offset += choices.len();
        }
    }
    if budget_exhausted {
        json!({"scope":"global_terminal_route","proof":"unproven","reason":"search_budget_exhausted",
        "truncated":true,"explored_states":explored,"blockers":blockers,"route":null,"first_suggestion":null})
    } else if let Some(best) = best {
        let first = best.steps.first().cloned();
        json!({"scope":"global_terminal_route","proof":"proven","reason":"complete terminal route found","truncated":false,
        "explored_states":explored,"terminal_hp":best.state.hp.get(),"terminal_attack":best.state.attack.get(),
        "terminal_defense":best.state.defense.get(),"blockers":blockers,"route":{"step_count":best.steps.len(),"steps":best.steps},"first_suggestion":first})
    } else {
        json!({"scope":"global_terminal_route","proof":if blockers.is_empty(){"unproven"}else{"unsupported"},"reason":"no_complete_supported_route",
        "truncated":false,"explored_states":explored,"blockers":blockers,"route":null,"first_suggestion":null})
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

    fn terminal_node(attack: u64, defense: u64, hp: u64, route: &str) -> TerminalRoute {
        TerminalRoute {
            state: SolverState {
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
                consumed: Arc::new(Vec::new()),
                shop_counts: Arc::new(Vec::new()),
                flags: Arc::new(Vec::new()),
            },
            steps: vec![json!({"route": route})],
        }
    }

    #[test]
    fn terminal_route_order_is_attributes_then_balance_then_hp_then_route() {
        let hp_rich = terminal_node(10, 10, 10_000, "b");
        let stronger = terminal_node(11, 10, 1, "z");
        assert!(terminal_route_is_better(&stronger, &hp_rich));

        let unbalanced = terminal_node(19, 1, 10_000, "a");
        let balanced = terminal_node(10, 10, 1, "z");
        assert!(terminal_route_is_better(&balanced, &unbalanced));

        let low_hp = terminal_node(10, 10, 5, "a");
        let high_hp = terminal_node(10, 10, 6, "z");
        assert!(terminal_route_is_better(&high_hp, &low_hp));

        let later = terminal_node(10, 10, 6, "z");
        let earlier = terminal_node(10, 10, 6, "a");
        assert!(terminal_route_is_better(&earlier, &later));
        assert!(!terminal_route_is_better(&later, &earlier));
        assert!(!terminal_route_is_better(&earlier, &earlier));

        let overflow_safe = terminal_node(u64::MAX, u64::MAX, 1, "a");
        assert!(terminal_route_is_better(&overflow_safe, &stronger));
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
            },
            SolverBlock {
                floor: "F".into(),
                x: 2,
                y: 0,
                id: "redGem".into(),
                kind: "resource".into(),
                data: json!({"delta":{"hp":0,"attack":3,"defense":0,"gold":0,
                    "experience":0,"keys":{"yellow":0,"blue":0,"red":0},"inventory":{}}}),
            },
        ];
        let arena = vec![
            RouteLink {
                parent: None,
                action: None,
            },
            RouteLink {
                parent: Some(0),
                action: Some(RouteAction::Block {
                    index: 0,
                    action: BlockRouteAction::Door {
                        yellow: 1,
                        blue: 0,
                        red: 0,
                    },
                }),
            },
            RouteLink {
                parent: Some(1),
                action: Some(RouteAction::Block {
                    index: 1,
                    action: BlockRouteAction::Resource,
                }),
            },
        ];
        assert_eq!(
            reconstruct_steps(&arena, 2, &blocks),
            vec![
                json!({"step_kind":"door","floor_id":"F","x":1,"y":0,
                    "block_id":"yellowDoor","details":{"key_cost":{"yellow":1,"blue":0,"red":0}}}),
                json!({"step_kind":"resource","floor_id":"F","x":2,"y":0,
                    "block_id":"redGem","details":blocks[1].data["delta"]}),
            ]
        );
    }

    #[test]
    fn typed_structural_key_matches_legacy_json_fields_and_distinguishes_each_field() {
        let mut state = terminal_node(10, 11, 100, "x").state;
        state.floor = "F1".into();
        state.x = 2;
        state.y = 3;
        state.inventory = Arc::new(vec![("book".into(), 1)]);
        state.consumed = Arc::new(vec![false, true]);
        state.shop_counts = Arc::new(vec![2]);
        state.level = 4;
        state.flags = Arc::new(vec![("quest".into(), 1)]);
        let key = StructuralKey::from(&state);
        let legacy = json!({"floor":state.floor,"x":state.x,"y":state.y,
            "inventory":&*state.inventory,"consumed":&*state.consumed,
            "shops":&*state.shop_counts,"level":state.level,"flags":&*state.flags});
        assert_eq!(legacy.as_object().unwrap().len(), 8);
        assert_eq!(legacy["floor"], key.floor);
        assert_eq!(legacy["x"], key.x);
        assert_eq!(legacy["y"], key.y);
        assert_eq!(legacy["inventory"], json!(&*key.inventory));
        assert_eq!(legacy["consumed"], json!(&*key.consumed));
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
        Arc::make_mut(&mut changed.consumed)[0] = true;
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
        let mut parent = terminal_node(10, 10, 100, "x").state;
        parent.inventory = Arc::new(vec![("book".into(), 1)]);
        parent.consumed = Arc::new(vec![false, false]);
        parent.shop_counts = Arc::new(vec![0]);
        parent.flags = Arc::new(vec![("quest".into(), 1)]);
        let mut child = parent.clone();
        assert!(Arc::ptr_eq(&parent.inventory, &child.inventory));
        assert!(Arc::ptr_eq(&parent.consumed, &child.consumed));
        assert!(Arc::ptr_eq(&parent.shop_counts, &child.shop_counts));
        assert!(Arc::ptr_eq(&parent.flags, &child.flags));

        state_set(&mut child.inventory, "cross", 1);
        set_consumed(&mut child, 0, true);
        Arc::make_mut(&mut child.shop_counts)[0] = 1;
        state_set(&mut child.flags, "quest", 2);
        assert!(!Arc::ptr_eq(&parent.inventory, &child.inventory));
        assert!(!Arc::ptr_eq(&parent.consumed, &child.consumed));
        assert!(!Arc::ptr_eq(&parent.shop_counts, &child.shop_counts));
        assert!(!Arc::ptr_eq(&parent.flags, &child.flags));
        assert_eq!(&*parent.inventory, &[("book".into(), 1)]);
        assert_eq!(&*parent.consumed, &[false, false]);
        assert_eq!(&*parent.shop_counts, &[0]);
        assert_eq!(&*parent.flags, &[("quest".into(), 1)]);
        assert_eq!(state_count(&child.inventory, "cross"), 1);
        assert!(child.consumed[0]);
        assert_eq!(child.shop_counts[0], 1);
        assert_eq!(state_count(&child.flags, "quest"), 2);
    }

    #[test]
    fn audited_resource_math_keeps_javascript_fractional_number_semantics() {
        let mut state = terminal_node(10, 11, 1001, "x").state;
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
        };
        state.consumed = Arc::new(vec![false]);
        let details =
            apply_audited_event(&mut state, &block, 0, std::slice::from_ref(&block)).unwrap();
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
        };
        let gate_retry = SolverBlock {
            floor: "MT22".into(),
            x: 7,
            y: 3,
            id: "fairy".into(),
            kind: "event".into(),
            data: json!({"event":{"id":"wand_gate_retry"}}),
        };
        let wand = SolverBlock {
            floor: "MT23w".into(),
            x: 5,
            y: 6,
            id: "skill1".into(),
            kind: "resource".into(),
            data: json!({}),
        };
        let blocks = vec![gate_once.clone(), gate_retry.clone(), wand];
        let mut once = terminal_node(10, 10, 100, "x").state;
        once.consumed = Arc::new(vec![false; 3]);
        assert!(apply_audited_event(&mut once, &gate_once, 0, &blocks).is_some());
        assert!(once.consumed[0]);
        let mut retry = terminal_node(10, 10, 100, "x").state;
        retry.consumed = Arc::new(vec![false; 3]);
        assert!(apply_audited_event(&mut retry, &gate_retry, 1, &blocks).is_none());
        assert!(!retry.consumed[1]);
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
        };
        let floor = SolverFloor {
            width: 3,
            height: 1,
            cells: HashSet::from([(0, 0), (1, 0), (2, 0)]),
            blocks: vec![0],
        };
        let mut state = terminal_node(10, 10, 100, "x").state;
        state.floor = "F".into();
        state.consumed = Arc::new(vec![true]);
        assert!(
            reachable_cells(&state, &HashMap::from([("F".into(), floor)]), &[block])
                .contains(&(2, 0))
        );
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
            });
        }
        let mut state = terminal_node(5001, 5000, 200000, "x").state;
        state.floor = "MT_1".into();
        state.x = 6;
        state.y = 5;
        state.consumed = Arc::new(
            (0..blocks.len())
                .map(|index| index > 0 && index % 2 == 0)
                .collect(),
        );
        assert!(apply_audited_event(&mut state, &gate, 0, &blocks).is_some());
        for (x, y, _, new) in positions {
            let active: Vec<_> = blocks
                .iter()
                .enumerate()
                .filter(|(index, block)| {
                    block.floor == "MT_1" && block.x == x && block.y == y && !state.consumed[*index]
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
        let reachable = reachable_cells(&state, &floors, &blocks);
        assert!(reachable.contains(&(5, 4)));
        assert!(!reachable.contains(&(6, 4)));
        let octopus = blocks
            .iter()
            .position(|block| block.data["numeric_id"] == 258)
            .unwrap();
        assert!(enemy_loss(&state, &blocks[octopus].data["enemy"]).is_some());
        Arc::make_mut(&mut state.consumed)[octopus] = true;
        assert!(reachable_cells(&state, &floors, &blocks).contains(&(6, 4)));
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
        };
        let mt2_door = SolverBlock {
            floor: "MT2".into(),
            x: 2,
            y: 7,
            id: "door".into(),
            kind: "door".into(),
            data: json!({}),
        };
        let road_a = SolverBlock {
            floor: "MT18".into(),
            x: 6,
            y: 9,
            id: "wall".into(),
            kind: "opaque".into(),
            data: json!({}),
        };
        let road_b = SolverBlock {
            floor: "MT18".into(),
            x: 6,
            y: 10,
            id: "wall".into(),
            kind: "opaque".into(),
            data: json!({}),
        };
        let blocks = vec![thief.clone(), mt2_door, road_a, road_b];
        let mut state = terminal_node(10, 10, 100, "x").state;
        state.flags = Arc::new(vec![("switch:MT4:6,1:A".into(), 2)]);
        state.inventory = Arc::new(vec![("icePickaxe".into(), 1)]);
        state.consumed = Arc::new(vec![false; blocks.len()]);
        assert!(apply_audited_event(&mut state, &thief, 0, &blocks).is_some());
        assert!(!state.consumed[1]);
        assert!(state.consumed[2]);
        assert!(state.consumed[3]);
        assert_eq!(state_count(&state.inventory, "icePickaxe"), 0);

        let princess = SolverBlock {
            floor: "MT18".into(),
            x: 6,
            y: 5,
            id: "princess".into(),
            kind: "event".into(),
            data: json!({"event":{"id":"princess_quest"}}),
        };
        state.flags = Arc::new(vec![("switch:MT18:6,5:A".into(), 1)]);
        Arc::make_mut(&mut state.consumed).push(false);
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
    fn global_search_budget_exhaustion_is_unproven_and_deterministic() {
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
        let complete = shadow_response(
            &request_with(two_terminal_routes(4)),
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
