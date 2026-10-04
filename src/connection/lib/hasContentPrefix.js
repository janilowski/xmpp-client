export default function hasContentPrefix(element, namespace) {
  if (element.name.includes(":") && element.getNS() === namespace) {
    return true;
  }

  for (const child of element.children) {
    if (
      typeof child?.getNS === "function" &&
      hasContentPrefix(child, namespace)
    ) {
      return true;
    }
  }
  return false;
}
