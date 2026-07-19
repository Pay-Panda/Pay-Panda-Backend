/** Parses ?from=&to= query params into full-day bounds, defaulting to the last 30 days. */
function parseDateRange(query) {
  const to = query.to ? new Date(query.to) : new Date();
  const from = query.from ? new Date(query.from) : new Date(to.getTime() - 29 * 86400000);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) throw Object.assign(new Error('Invalid date range'), { statusCode: 400 });
  const fromStart = new Date(from); fromStart.setHours(0, 0, 0, 0);
  const toEnd = new Date(to); toEnd.setHours(23, 59, 59, 999);
  return { from: fromStart, to: toEnd };
}

module.exports = { parseDateRange };
