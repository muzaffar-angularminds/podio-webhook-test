/**
 * Extracts normalised values from Podio field objects.
 *
 * Podio stores field values differently per type:
 * - text/calculation/number: values[0].value is a plain string/number
 * - category: values[0].value is { id, status, text, color }
 * - app (reference): values[0].value is { item_id, app_item_id, title }
 * - date: values[0] IS the date object (no .value wrapper) — { start, start_utc, ... }
 * - contact: values[0].value is { id, name, avatar, ... }
 * - location: values[0] has { value, lat, lng, city, state, ... }
 * - duration: values[0].value is seconds (number or string like "7 min 24 sec")
 */

/**
 * Extract normalised value from a single Podio field object.
 * @param {Object} field - { type, label, values, fieldId, externalId }
 * @returns {*} Extracted value, or null if empty
 */
function extractFieldValue(field) {
  if (!field || !Array.isArray(field.values) || field.values.length === 0) {
    return null;
  }

  const { type, values } = field;
  const element = values[0];

  switch (type) {
    case "text":
    case "number":
    case "calculation":
    case "email":
    case "phone":
    case "tel":
    case "embed":
    case "progress":
      return element.value ?? null;

    case "money":
      if (typeof element.value === "object" && element.value !== null && "value" in element.value) {
        return parseFloat(element.value.value) || 0;
      }
      if (typeof element.value === "string") return parseFloat(element.value) || 0;
      return element.value ?? null;

    case "category":
      if (!element.value) return null;
      return element.value.text ?? null;

    case "app":
      if (!element.value) return null;
      return element.value.title ?? null;

    case "date":
      // Date fields don't have .value — the element itself IS the date object
      return element.start_utc ?? element.start ?? null;

    case "contact":
      if (!element.value) return null;
      if (typeof element.value === "object" && "name" in element.value) return element.value.name;
      if (typeof element.value === "string") return element.value;
      // Some contact fields put name at entry level
      if ("name" in element) return element.name;
      return null;

    case "location":
      // Location fields: value is the formatted string, but city/state/lat/lng are at entry level
      return element.value ?? element.formatted ?? null;

    case "duration":
      if (typeof element.value === "number") return element.value;
      if (typeof element.value === "string") return parseDuration(element.value);
      return null;

    default:
      return element.value !== undefined ? element.value : element;
  }
}

/**
 * Extract raw structured value (full object) from a field.
 * Returns the complete value object for types that have structured data.
 * Useful for category (need id), app ref (need item_id), date (need all parts).
 * @param {Object} field
 * @returns {*}
 */
function extractFieldValueRaw(field) {
  if (!field || !Array.isArray(field.values) || field.values.length === 0) {
    return null;
  }
  const element = field.values[0];
  // Date fields: element IS the value
  if (field.type === "date") return element;
  return element.value ?? element;
}

/**
 * Extract values from ALL fields in an item's fields map.
 * Returns a flat { externalId: value } object.
 * @param {Object} fieldsMap - The rawFields map from MongoDB
 * @returns {Object}
 */
function extractAllFields(fieldsMap) {
  if (!fieldsMap || typeof fieldsMap !== "object") return {};

  const result = {};
  const entries = fieldsMap instanceof Map ? fieldsMap.entries() : Object.entries(fieldsMap);

  for (const [externalId, field] of entries) {
    result[externalId] = extractFieldValue(field);
  }
  return result;
}

/**
 * Extract a single field value by externalId.
 * @param {Object} fieldsMap
 * @param {string} externalId
 * @returns {*}
 */
function extractField(fieldsMap, externalId) {
  if (!fieldsMap) return null;
  const field = fieldsMap instanceof Map ? fieldsMap.get(externalId) : fieldsMap[externalId];
  if (!field) return null;
  return extractFieldValue(field);
}

/**
 * Parse duration strings like "7 min 24 sec", "19 sec", "1 h 5 min" into total seconds.
 */
function parseDuration(str) {
  let total = 0;
  const hours = str.match(/(\d+)\s*h/i);
  if (hours) total += parseInt(hours[1], 10) * 3600;
  const mins = str.match(/(\d+)\s*min/i);
  if (mins) total += parseInt(mins[1], 10) * 60;
  const secs = str.match(/(\d+)\s*sec/i);
  if (secs) total += parseInt(secs[1], 10);
  if (!hours && !mins && !secs) {
    const n = parseInt(str, 10);
    return isNaN(n) ? null : n;
  }
  return total;
}

module.exports = { extractFieldValue, extractFieldValueRaw, extractAllFields, extractField };
