/**
 * Transforms a raw Podio API item response into storage format.
 *
 * rawFields: keyed by external_id, contains full field metadata + values
 * transformedFields: flat key:value map of only the fields listed in extractFields config
 *                    keys use underscores instead of hyphens for clean MongoDB queries
 */
const { extractFieldValue } = require("./extractFieldValue");
const apps = require("../config/apps");

// Pre-build lookups from config
const extractFieldsByApp = new Map();
const appNamesByApp = new Map();
for (const app of apps) {
  if (app.extractFields) {
    extractFieldsByApp.set(app.appId, new Set(app.extractFields));
  }
  appNamesByApp.set(app.appId, app.name);
}

/**
 * Convert hyphenated external_id to underscore key for MongoDB-friendly queries.
 * "status-dont-touch" -> "status_dont_touch"
 */
const toKey = (externalId) => externalId.replace(/-/g, "_");

const transformAppItem = (raw) => {
  const rawFields = {};
  const appId = raw.app_id;
  const fieldsToExtract = extractFieldsByApp.get(Number(appId));

  for (const field of raw.fields || []) {
    rawFields[field.external_id] = {
      values: trimValues(field.type, field.values),
      fieldId: field.field_id,
      label: field.label,
      type: field.type,
      externalId: field.external_id,
    };
  }

  // Build transformedFields — only fields listed in extractFields config
  const transformedFields = {};
  if (fieldsToExtract) {
    for (const externalId of fieldsToExtract) {
      if (rawFields[externalId]) {
        transformedFields[toKey(externalId)] = extractFieldValue(rawFields[externalId]);
      }
    }
  }

  return {
    itemId: raw.item_id,
    appId: raw.app_id,
    appName: appNamesByApp.get(Number(raw.app_id)) || null,
    appItemId: raw.app_item_id,
    title: raw.title || null,
    rawFields,
    transformedFields,
    createdOn: raw.created_on ? new Date(raw.created_on) : null,
    lastEventOn: raw.last_event_on ? new Date(raw.last_event_on) : null,
  };
};

/**
 * Trim values based on field type.
 * Most types pass through as-is. App references get heavily trimmed.
 */
const trimValues = (type, values) => {
  if (!values) return [];

  switch (type) {
    case "app":
      return values.map((v) => ({
        value: {
          item_id: v.value?.item_id,
          app_item_id: v.value?.app_item_id,
          title: v.value?.title || null,
        },
      }));

    default:
      return values;
  }
};

module.exports = transformAppItem;
