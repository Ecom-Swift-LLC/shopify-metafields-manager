'use strict';

const { toCsv } = require('./csv');

const EXPORT_COLUMNS = ['ownerId', 'handle', 'label', 'namespace', 'key', 'type', 'value'];

/** One row per metafield value ("long" format) — the same shape `import` reads. */
function ownersToRows(owners) {
  const rows = [];
  for (const o of owners) {
    for (const m of o.metafields) {
      rows.push({
        ownerId: o.id,
        handle: o.handle,
        label: o.label,
        namespace: m.namespace,
        key: m.key,
        type: m.type,
        value: m.value,
      });
    }
  }
  return rows;
}

function ownersToCsv(owners) {
  return toCsv(ownersToRows(owners), EXPORT_COLUMNS);
}

module.exports = { ownersToRows, ownersToCsv, EXPORT_COLUMNS };
