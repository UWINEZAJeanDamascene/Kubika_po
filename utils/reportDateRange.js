function inclusiveEndDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return date;
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    date.setUTCHours(23, 59, 59, 999);
  }
  return date;
}

module.exports = { inclusiveEndDate };
