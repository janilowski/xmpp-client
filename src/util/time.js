export function datetime(d = new Date()) {
  if (typeof d === "string") {
    d = new Date(d);
  }

  return new Date(d).toISOString().split(".")[0] + "Z";
}
