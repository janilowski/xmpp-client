const GREGORIAN_CYCLE_YEARS = 400;
const REFERENCE_YEAR = 2000;

export default function isUnexpired(element) {
  if (element.getChildElements().length) {
    return false;
  }
  const value = element.getText().replace(/^[\t\n\r ]+|[\t\n\r ]+$/g, "");
  // XRD 1.0 §2.2: UTC, whole seconds; expired/invalid dates fail closed.
  const match =
    /^(\d{4}|[1-9]\d{4,})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T(?:[01]\d:[0-5]\d:[0-5]\d|2[0-3]:[0-5]\d:[0-5]\d|24:00:00)Z$/.exec(
      value,
    );
  if (!match || match[1] === "0000") {
    return false;
  }
  const [, year, month, day] = match;
  // Gregorian leap days repeat every 400 years, including expanded XSD years.
  const cycleYear =
    REFERENCE_YEAR + (Number(year.slice(-4)) % GREGORIAN_CYCLE_YEARS);
  const daysInMonth = new Date(
    Date.UTC(cycleYear, Number(month), 0),
  ).getUTCDate();
  if (Number(day) > daysInMonth) {
    return false;
  }
  const now = new Date(Date.now()).toISOString().slice(0, 19);
  return year.length > 4 || value.slice(0, -1) > now;
}
