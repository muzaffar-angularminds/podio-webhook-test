/**
 * Compare two Podio schema field arrays and return a list of structural changes.
 * Uses field_id as the stable key for comparison.
 *
 * Detects: field_added, field_deleted, field_renamed,
 *          field_type_changed, category_options_changed
 */
function diffSchemas(oldFields, newFields) {
  const changes = [];
  const oldMap = new Map((oldFields || []).map((f) => [f.field_id, f]));
  const newMap = new Map((newFields || []).map((f) => [f.field_id, f]));

  for (const [id, newField] of newMap) {
    if (!oldMap.has(id)) {
      changes.push({
        type: "field_added",
        fieldId: id,
        externalId: newField.external_id || null,
        label: newField.config?.label,
      });
    } else {
      const old = oldMap.get(id);
      if (old.config?.label !== newField.config?.label) {
        changes.push({
          type: "field_renamed",
          fieldId: id,
          externalId: newField.external_id || null,
          from: old.config?.label,
          to: newField.config?.label,
        });
      }
      if (old.type !== newField.type) {
        changes.push({
          type: "field_type_changed",
          fieldId: id,
          externalId: newField.external_id || null,
          label: newField.config?.label,
          from: old.type,
          to: newField.type,
        });
      }
      if (newField.type === "category") {
        const oldOpts = JSON.stringify(old.config?.settings?.options || []);
        const newOpts = JSON.stringify(newField.config?.settings?.options || []);
        if (oldOpts !== newOpts) {
          changes.push({
            type: "category_options_changed",
            fieldId: id,
            externalId: newField.external_id || null,
            label: newField.config?.label,
          });
        }
      }
    }
  }

  for (const [id, oldField] of oldMap) {
    if (!newMap.has(id)) {
      changes.push({
        type: "field_deleted",
        fieldId: id,
        externalId: oldField.external_id || null,
        label: oldField.config?.label,
      });
    }
  }

  return changes;
}

module.exports = diffSchemas;
