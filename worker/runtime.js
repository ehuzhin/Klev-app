const COLXR = "7ddf754f-d193-4cc9-b351-99906754a03b";

const jsonResponse = (payload, status = 200) => new Response(JSON.stringify(payload), {
  status,
  headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
});

async function fetchJson(url, options = {}) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(18000) });
  if (!response.ok) throw new Error(`upstream ${response.status}`);
  return response.json();
}

async function weatherAt(lat, lon) {
  const url = new URL("https://api.open-meteo.com/v1/forecast");
  url.search = new URLSearchParams({
    latitude: String(lat), longitude: String(lon),
    current: "temperature_2m,precipitation,rain,showers,snowfall,weather_code,cloud_cover,pressure_msl,wind_speed_10m,wind_direction_10m,is_day",
    hourly: "pressure_msl", past_hours: "25", forecast_hours: "1",
    timezone: "auto", timeformat: "unixtime", wind_speed_unit: "ms",
  }).toString();
  return fetchJson(url);
}

function distanceMeters(lat1, lon1, lat2, lon2) {
  const rad = value => value * Math.PI / 180;
  const dLat = rad(lat2 - lat1), dLon = rad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 6371000 * 2 * Math.asin(Math.sqrt(a));
}

function classifyWater(tags) {
  if (tags.water === "river" || /^(river|stream|canal|drain)$/i.test(tags.waterway || "")) return "river";
  if (tags.water === "pond") return "pond";
  if (tags.natural === "water" || tags.landuse === "reservoir" || tags.water === "reservoir" || tags.water === "lake") return "lake";
  return null;
}

function collectWater(elements, lat, lon) {
  const items = [];
  for (const item of elements || []) {
    const tags = item.tags || {}, kind = classifyWater(tags), point = item.center || item;
    if (!kind || point.lat == null || point.lon == null) continue;
    items.push({
      id: item.id, type: item.type, kind, tags,
      lat: Number(point.lat), lon: Number(point.lon),
      distance: distanceMeters(lat, lon, Number(point.lat), Number(point.lon)),
    });
  }
  items.sort((a, b) => a.distance - b.distance);
  const unique = [], seen = new Set();
  for (const item of items) {
    const name = item.tags["name:ru"] || item.tags.name || ({river: "Водоток без названия", pond: "Пруд без названия", lake: "Водоём без названия"})[item.kind];
    const key = `${name.toLowerCase()}|${item.kind}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push({
      id: item.id, type: item.type, kind: item.kind, name,
      lat: item.lat, lon: item.lon, distance: Math.round(item.distance),
    });
    if (unique.length >= 8) break;
  }
  return unique;
}

function xmlAttributes(source) {
  const result = {};
  for (const match of source.matchAll(/([\w:]+)="([^"]*)"/g)) result[match[1]] = match[2].replaceAll("&amp;", "&").replaceAll("&quot;", '"').replaceAll("&lt;", "<").replaceAll("&gt;", ">");
  return result;
}

function xmlTags(body) {
  const tags = {};
  for (const match of body.matchAll(/<tag\b([^>]*)\/?\s*>/g)) {
    const attrs = xmlAttributes(match[1]);
    if (attrs.k) tags[attrs.k] = attrs.v || "";
  }
  return tags;
}

function parseOsmMap(xml, lat, lon) {
  const nodes = new Map(), features = [];
  for (const match of xml.matchAll(/<node\b([^>]*?)(?:\/>|>([\s\S]*?)<\/node>)/g)) {
    const attrs = xmlAttributes(match[1]);
    if (!attrs.id || attrs.lat == null || attrs.lon == null) continue;
    const node = { id: attrs.id, lat: Number(attrs.lat), lon: Number(attrs.lon), tags: xmlTags(match[2] || "") };
    nodes.set(node.id, node);
    if (classifyWater(node.tags)) features.push({ type: "node", id: node.id, tags: node.tags, points: [node] });
  }
  const ways = new Map();
  for (const match of xml.matchAll(/<way\b([^>]*)>([\s\S]*?)<\/way>/g)) {
    const attrs = xmlAttributes(match[1]), body = match[2];
    const refs = [...body.matchAll(/<nd\b([^>]*)\/?\s*>/g)].map(entry => xmlAttributes(entry[1]).ref).filter(Boolean);
    const points = refs.map(ref => nodes.get(ref)).filter(Boolean), tags = xmlTags(body);
    if (!attrs.id) continue;
    ways.set(attrs.id, { id: attrs.id, tags, points });
    if (classifyWater(tags) && points.length) features.push({ type: "way", id: attrs.id, tags, points });
  }
  for (const match of xml.matchAll(/<relation\b([^>]*)>([\s\S]*?)<\/relation>/g)) {
    const attrs = xmlAttributes(match[1]), body = match[2], tags = xmlTags(body), kind = classifyWater(tags);
    if (!attrs.id || !kind) continue;
    const refs = [...body.matchAll(/<member\b([^>]*)\/?\s*>/g)].map(entry => xmlAttributes(entry[1])).filter(entry => entry.type === "way").map(entry => entry.ref);
    const points = refs.flatMap(ref => ways.get(ref)?.points || []);
    if (points.length) features.push({ type: "relation", id: attrs.id, tags, points });
  }
  return collectWater(features.map(feature => {
    const nearest = feature.points.reduce((best, point) => distanceMeters(lat, lon, point.lat, point.lon) < distanceMeters(lat, lon, best.lat, best.lon) ? point : best, feature.points[0]);
    return { type: feature.type, id: feature.id, tags: feature.tags, lat: nearest.lat, lon: nearest.lon };
  }), lat, lon);
}

async function waterFromOpenStreetMap(lat, lon) {
  const query = `[out:json][timeout:18];(nwr(around:5000,${lat},${lon})[natural=water];nwr(around:5000,${lat},${lon})[waterway~"river|stream|canal"];nwr(around:5000,${lat},${lon})[landuse=reservoir];);out center tags;`;
  try {
    const response = await fetch("https://overpass-api.de/api/interpreter", {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded;charset=UTF-8", "user-agent": "KlevaMeter/1.0" },
      body: new URLSearchParams({ data: query }), signal: AbortSignal.timeout(20000),
    });
    if (!response.ok) throw new Error(`Overpass ${response.status}`);
    const data = await response.json();
    return collectWater(data.elements, lat, lon);
  } catch {
    const radiusLat = 0.005, radiusLon = Math.min(0.02, radiusLat / Math.max(0.15, Math.cos(lat * Math.PI / 180)));
    const bounds = [lon - radiusLon, lat - radiusLat, lon + radiusLon, lat + radiusLat].join(",");
    const response = await fetch(`https://api.openstreetmap.org/api/0.6/map?bbox=${bounds}`, {
      headers: { "user-agent": "KlevaMeter/1.0", accept: "application/xml" }, signal: AbortSignal.timeout(20000),
    });
    if (!response.ok) throw new Error(`OpenStreetMap ${response.status}`);
    return parseOsmMap(await response.text(), lat, lon);
  }
}

async function fishNear(lat, lon) {
  const matchUrl = new URL("https://api.gbif.org/v2/species/match");
  matchUrl.search = new URLSearchParams({ scientificName: "Teleostei", checklistKey: COLXR }).toString();
  const match = await fetchJson(matchUrl);
  const classKey = match.usage?.key;
  if (!classKey) throw new Error("GBIF did not return the fish taxon");
  const params = new URLSearchParams({
    classKey, checklistKey: COLXR, geoDistance: `${lat},${lon},10km`,
    hasCoordinate: "true", hasGeospatialIssue: "false", year: "2000,2026", limit: "300",
  });
  const records = await fetchJson(`https://api.gbif.org/v1/occurrence/search?${params}`);
  const grouped = new Map();
  for (const record of records.results || []) {
    if (record.taxonRank && record.taxonRank !== "SPECIES") continue;
    const key = record.speciesKey || record.taxonKey, name = String(record.species || record.scientificName || "").replace(/\s+\([^)]*\)$/, "").replace(/\s+[A-Z][a-z].*$/, "");
    if (!key || !name) continue;
    const row = grouped.get(key) || { key, name, count: 0, year: 0 };
    row.count++;
    row.year = Math.max(row.year, Number(record.year) || 0);
    grouped.set(key, row);
  }
  const common = {
    "Esox lucius": "Щука", "Perca fluviatilis": "Окунь", "Cyprinus carpio": "Карп / сазан",
    "Carassius gibelio": "Карась", "Carassius carassius": "Карась", "Abramis brama": "Лещ",
    "Sander lucioperca": "Судак", "Salmo trutta": "Форель", "Rutilus rutilus": "Плотва", "Silurus glanis": "Сом",
  };
  const rows = [...grouped.values()].sort((a, b) => b.count - a.count).slice(0, 8);
  return Promise.all(rows.map(async row => {
    if (common[row.name]) return { ...row, label: common[row.name] };
    try {
      const names = await fetchJson(`https://api.gbif.org/v1/species/${row.key}/vernacularNames?limit=100`);
      const list = Array.isArray(names) ? names : names.results || [];
      const choice = list.find(item => /^rus$/i.test(item.language || "")) || list.find(item => /^kaz$/i.test(item.language || "")) || list.find(item => /^eng$/i.test(item.language || ""));
      return { ...row, label: choice?.vernacularName || row.name };
    } catch { return { ...row, label: row.name }; }
  }));
}

async function placeAt(lat, lon) {
  const data = await fetchJson(`https://photon.komoot.io/reverse?lat=${lat}&lon=${lon}&limit=1`);
  const props = data.features?.[0]?.properties;
  if (!props) return null;
  const label = [...new Set([props.city || props.town || props.village || props.district, props.state, props.country].filter(Boolean))].join(", ");
  return { label: label || props.name || "Место без названия", street: props.street || "" };
}

async function locationData(url) {
  const lat = Number(url.searchParams.get("lat")), lon = Number(url.searchParams.get("lon"));
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return jsonResponse({ error: "Некорректные координаты." }, 400);
  if (!url.searchParams.has("lat") || !url.searchParams.has("lon")) return jsonResponse({ error: "Нужны координаты." }, 400);
  const sources = { weather: weatherAt, water: waterFromOpenStreetMap, fish: fishNear, place: placeAt };
  const resource = url.searchParams.get("resource");
  if (resource) {
    if (!sources[resource]) return jsonResponse({ error: "Неизвестный источник." }, 400);
    try { return jsonResponse({ [resource]: await sources[resource](lat, lon) }); }
    catch (error) { return jsonResponse({ error: `Источник ${resource} временно недоступен.`, detail: String(error.message) }, 502); }
  }
  const keys = Object.keys(sources);
  const results = await Promise.allSettled(keys.map(key => sources[key](lat, lon)));
  const data = { errors: {} };
  results.forEach((result, i) => {
    data[keys[i]] = result.status === "fulfilled" ? result.value : null;
    if (result.status === "rejected") data.errors[keys[i]] = String(result.reason?.message || "Unavailable");
  });
  return jsonResponse(data);
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/api/location" && request.method === "GET") return locationData(url);
    if (url.pathname === "/" || url.pathname === "/index.html") return new Response(page, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
    return new Response("Not found", { status: 404 });
  },
};
