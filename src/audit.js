'use strict';

/**
 * Compares defined metafields against the values actually present.
 *
 * definitions: output of fetchDefinitions
 * owners:      output of fetchAllOwners (unfiltered by namespace)
 */
function buildAudit(definitions, owners, { maxMissing = 20 } = {}) {
  const total = owners.length;
  const keyOf = (ns, key) => `${ns}.${key}`;
  const defined = new Map(definitions.map((d) => [keyOf(d.namespace, d.key), d]));

  const filled = new Map(); // "ns.key" -> owners with a non-empty value
  const undefinedSeen = new Map(); // "ns.key" -> { count, type }
  const missingByDef = new Map(definitions.map((d) => [keyOf(d.namespace, d.key), []]));

  for (const owner of owners) {
    const present = new Set();
    for (const m of owner.metafields) {
      if (m.value === null || m.value === undefined || m.value === '') continue;
      const k = keyOf(m.namespace, m.key);
      present.add(k);
      filled.set(k, (filled.get(k) || 0) + 1);
      if (!defined.has(k)) {
        const cur = undefinedSeen.get(k) || { count: 0, type: m.type };
        cur.count += 1;
        undefinedSeen.set(k, cur);
      }
    }
    for (const [k, list] of missingByDef) {
      if (!present.has(k)) list.push({ id: owner.id, handle: owner.handle, label: owner.label });
    }
  }

  const coverage = definitions.map((d) => {
    const k = keyOf(d.namespace, d.key);
    const count = filled.get(k) || 0;
    const missing = missingByDef.get(k);
    return {
      definition: k,
      name: d.name,
      type: d.type,
      filled: count,
      total,
      coveragePct: total ? Math.round((count / total) * 1000) / 10 : 0,
      missingCount: missing.length,
      missingSample: missing.slice(0, maxMissing),
    };
  });

  return {
    totalOwners: total,
    totalDefinitions: definitions.length,
    coverage,
    unusedDefinitions: coverage.filter((c) => c.filled === 0).map((c) => c.definition),
    undefinedMetafields: [...undefinedSeen.entries()].map(([k, v]) => ({ metafield: k, type: v.type, owners: v.count })),
  };
}

function auditToMarkdown(report, ownerType) {
  const lines = [];
  lines.push(`# Metafield audit — ${ownerType}`);
  lines.push('');
  lines.push(`- ${ownerType} records scanned: **${report.totalOwners}**`);
  lines.push(`- Metafield definitions: **${report.totalDefinitions}**`);
  lines.push(`- Definitions with no values anywhere: **${report.unusedDefinitions.length}**`);
  lines.push(`- Metafields in use with no definition: **${report.undefinedMetafields.length}**`);
  lines.push('');
  lines.push('## Coverage by definition');
  lines.push('');
  if (report.coverage.length === 0) {
    lines.push('_No metafield definitions exist for this owner type._');
  } else {
    lines.push('| Definition | Type | Filled | Coverage | Missing |');
    lines.push('| --- | --- | --- | --- | --- |');
    for (const c of report.coverage) {
      lines.push(`| \`${c.definition}\` | ${c.type} | ${c.filled}/${c.total} | ${c.coveragePct}% | ${c.missingCount} |`);
    }
  }
  if (report.unusedDefinitions.length) {
    lines.push('', '## Unused definitions', '');
    for (const d of report.unusedDefinitions) lines.push(`- \`${d}\``);
  }
  if (report.undefinedMetafields.length) {
    lines.push('', '## Values without a definition', '');
    lines.push('| Metafield | Type | Records |');
    lines.push('| --- | --- | --- |');
    for (const u of report.undefinedMetafields) lines.push(`| \`${u.metafield}\` | ${u.type} | ${u.owners} |`);
  }
  return lines.join('\n');
}

module.exports = { buildAudit, auditToMarkdown };
