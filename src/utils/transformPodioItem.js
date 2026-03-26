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
    item_id: raw.item_id,
    app_id: raw.app_id,
    app_item_id: raw.app_item_id,
    title: raw.title || null,
    data: fields,
    podio_created_on: raw.created_on ? new Date(raw.created_on) : null,
    podio_last_event_on: raw.last_event_on
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
