/**
 * core.logger — structured JSON lines on stdout (journald captures them).
 * Set LOG_FORMAT=text for readable lines while developing; LOG_LEVEL filters.
 *
 *   const log = logger.forBot('sponsor-licence-scout');
 *   log.info('Diffed snapshot', { added: 3 });
 *   const harvestLog = log.child({ stage: 'harvest' });
 */
const LEVELS = Object.freeze({ debug: 10, info: 20, warn: 30, error: 40 });

function serialise(value) {
  if (value instanceof Error) return { name: value.name, message: value.message, stack: value.stack };
  return value;
}

function textFields(fields) {
  const entries = Object.entries(fields).filter(([, v]) => v !== undefined);
  return entries.length
    ? ` ${entries.map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(serialise(v))}`).join(' ')}`
    : '';
}

/**
 * @param {string} bot
 * @param {{ level?: string, format?: 'json'|'text', fields?: object, stream?: { write(s: string): any } }} [options]
 */
export function forBot(bot, options = {}) {
  const level = options.level ?? process.env.LOG_LEVEL?.trim().toLowerCase() ?? 'info';
  const min = LEVELS[level] ?? LEVELS.info;
  const format = options.format ?? (process.env.LOG_FORMAT?.trim().toLowerCase() === 'text' ? 'text' : 'json');
  const base = options.fields ?? {};
  const stream = options.stream ?? process.stdout;

  const emit = (lvl, msg, fields = {}) => {
    if (LEVELS[lvl] < min) return;
    const all = Object.fromEntries(Object.entries({ ...base, ...fields }).map(([k, v]) => [k, serialise(v)]));
    const ts = new Date().toISOString();
    const line = format === 'text'
      ? `${ts} ${lvl.toUpperCase().padEnd(5)} [${bot}] ${msg}${textFields(all)}`
      : JSON.stringify({ ts, level: lvl, bot, msg: String(msg), ...all });
    stream.write(`${line}\n`);
  };

  return Object.freeze({
    bot,
    debug: (msg, fields) => emit('debug', msg, fields),
    info: (msg, fields) => emit('info', msg, fields),
    warn: (msg, fields) => emit('warn', msg, fields),
    error: (msg, fields) => emit('error', msg, fields),
    child: (fields) => forBot(bot, { ...options, level, format, fields: { ...base, ...fields } }),
  });
}