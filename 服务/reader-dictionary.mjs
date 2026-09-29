// Shared by the offline UI, local audio endpoint, and regression tests.
export const normalizeWord = word => String(word).trim().toLowerCase().replaceAll('’', "'");
export function isAmericanSound(record) {
  return typeof record?.ipa === 'string' && record.ipa.trim() &&
    Array.isArray(record.tags) && record.tags.some(tag => tag === 'US' || tag === 'General-American') &&
    typeof record.rawPronunciation === 'string' && record.rawPronunciation.length > 0 &&
    record.conversionVersion === 'learner-us-1' &&
    ((record.origin === 'deepseek-flash-calibrated' && record.source === 'DeepSeek-Flash calibration' && /^deepseek-flash(?:-uncertain-followup)?-\d+$/.test(record.reviewVersion || '')) ||
      (record.origin === 'local-calibration' && record.source === 'deepseek-flash' && record.reviewVersion === 'deepseek-review-1') ||
      (record.origin === 'wiktionary' && typeof record.source === 'string' && record.source.startsWith('https://en.wiktionary.org/wiki/')) ||
      (record.origin === 'cmudict' && record.source === 'https://github.com/cmusphinx/cmudict' &&
       record.sourceRevision === '74790861f652b15e4ac49015a90074ad62a27690') ||
      (record.origin === 'source-audited' && typeof record.source === 'string' &&
       record.source.startsWith('https://dictionary.cambridge.org/') &&
       (record.source.includes('/pronunciation/english/') || record.source.includes('/us/dictionary/english/')) &&
       /^cambridge-us-\d{4}-\d{2}-\d{2}$/.test(record.reviewVersion || '')));
}
export function pronunciationsFor(data, raw) {
  if (![2,3].includes(data?.schema)) return [];
  const word = normalizeWord(raw);
  const records = (data.entries?.[word] || []).filter(isAmericanSound);
  // Never substitute an acronym's pronunciation for the lowercase word.
  const exactCase = records.filter(record => record.headword === raw);
  return exactCase.length ? exactCase : records.filter(record => record.headword === word);
}
export function localPronunciations(data, aliases, raw) {
  const exact = pronunciationsFor(data, raw);
  if (exact.length) return {exact, lemmas: []};
  const lemmas = [...new Set(aliases[normalizeWord(raw)] || [])]
    .map(word => ({word, records: pronunciationsFor(data, word)})).filter(x => x.records.length);
  return {exact: [], lemmas};
}
export function pronunciationGroups(records) {
  const groups = new Map();
  const pronunciationsByPos = new Map();
  for (const record of records) {
    const key = record.ipa;
    if (!groups.has(key)) groups.set(key, {...record, partsOfSpeech: [], posLabels: []});
    const pos = groups.get(key).partsOfSpeech;
    if (record.pos && !pos.includes(record.pos)) pos.push(record.pos);
    const label = record.posLabel || record.pos;
    if (label && !groups.get(key).posLabels.includes(label)) groups.get(key).posLabels.push(label);
    if (record.pos) {
      if (!pronunciationsByPos.has(record.pos)) pronunciationsByPos.set(record.pos, new Set());
      pronunciationsByPos.get(record.pos).add(key);
    }
  }
  // Only show POS labels when the same headword has different IPA by part of
  // speech. Multiple readings within one POS are variants, not POS distinctions.
  const posReadingSets = [...pronunciationsByPos.values()];
  const hasPosDependentPronunciation = posReadingSets.length > 1 &&
    posReadingSets.some((readings, index) => posReadingSets.slice(index + 1)
      .some(other => readings.size !== other.size || [...readings].some(ipa => !other.has(ipa))));
  if (!hasPosDependentPronunciation) {
    for (const group of groups.values()) group.posLabels = [];
  }
  return [...groups.values()];
}
export function dictionaryAudio(data, query) {
  const audio = [], seen = new Set(), word = normalizeWord(query);
  if (data?.audioOnly === 1) {
    for (const recording of Array.isArray(data.audio) ? data.audio : []) {
      try {
        const url = new URL(recording.url);
        const us = data.kind === 'merriam' ? url.hostname === 'media.merriam-webster.com' && url.pathname.startsWith('/audio/prons/en/us/mp3/') : /-us\.[a-z0-9]+$/i.test(url.pathname);
        if (url.protocol === 'https:' && us && normalizeWord(recording.word) === word && !seen.has(url.href)) {
          seen.add(url.href);audio.push({url: url.href, word: recording.word, label: recording.label || ''});
        }
      } catch { /* Reject malformed or unverified cached recordings. */ }
    }
    return {audioOnly: 1, kind: data.kind, source: data.source, audio};
  }
  // Both freshly fetched and old cached API results go through the same gate.
  for (const entry of Array.isArray(data?.entries) ? data.entries : []) {
    if (!entry || typeof entry !== 'object') continue;
    const headword = data.kind === 'merriam' ? entry.hwi?.hw?.replaceAll('*', '') : entry.word;
    if (normalizeWord(headword || '') !== word) continue;
    const prs = data.kind === 'merriam' ? entry.hwi?.prs || [] : entry.phonetics || [];
    for (const pr of prs) {
      let url;
      if (data.kind === 'merriam') {
        const name = pr.sound?.audio;
        if (!name || !/^[a-zA-Z0-9_-]+$/.test(name) || /british|\buk\b/i.test(pr.l || '')) continue;
        const folder = name.startsWith('bix') ? 'bix' : name.startsWith('gg') ? 'gg' : /^[0-9_]/.test(name) ? 'number' : name[0];
        url = `https://media.merriam-webster.com/audio/prons/en/us/mp3/${folder}/${name}.mp3`;
      } else {
        try {
          const parsed = new URL(pr.audio);
          if (parsed.protocol !== 'https:' || !/-us\.[a-z0-9]+$/i.test(parsed.pathname)) continue;
          url = parsed.href;
        } catch { continue; }
      }
      if (!seen.has(url)) {
        seen.add(url);
        audio.push({url, word: headword, label: data.kind === 'merriam' ? entry.fl || '' : ''});
      }
    }
  }
  // No phonetic / IPA fields survive this boundary, even from legacy caches.
  return {audioOnly: 1, kind: data?.kind, source: data?.source || '词典', audio};
}
