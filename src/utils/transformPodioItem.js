/**
 * Transforms a raw Podio API item response into a clean object for storage.
 * Strips field config/settings bloat, keeps only field_id, external_id, label, type, values.
 * Trims app reference values to just { item_id, app_item_id, title }.
 */
const transformPodioItem = (raw) => {
  const fields = (raw.fields || []).map((field) => {
    const stripped = {
      field_id: field.field_id,
      external_id: field.external_id,
      label: field.label,
      type: field.type,
      values: trimValues(field.type, field.values),
    };
    return stripped;
  });

  return {
    itemId: raw.item_id,
    appId: raw.app_id,
    appItemId: raw.app_item_id,
    title: raw.title || null,
    data: fields,
    podioCreatedOn: raw.created_on ? new Date(raw.created_on) : null,
    podioLastEventOn: raw.last_event_on
      ? new Date(raw.last_event_on)
      : null,
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

module.exports = transformPodioItem;
