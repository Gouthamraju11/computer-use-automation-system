(function observePage() {
  function visible(element) {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
  }

  function accessibleName(element) {
    const labelled = element.getAttribute("aria-label")?.trim();
    if (labelled) return labelled;
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) {
      const label = element.labels?.[0]?.innerText.trim();
      if (label) return label;
      if ((element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) && element.placeholder) {
        return element.placeholder;
      }
    }
    return (element.innerText || element.getAttribute("title") || element.getAttribute("name") || "").trim();
  }

  function roleFor(element) {
    const explicit = element.getAttribute("role");
    if (explicit) return explicit;
    if (element instanceof HTMLButtonElement) return "button";
    if (element instanceof HTMLAnchorElement) return "link";
    if (element instanceof HTMLSelectElement) return "combobox";
    if (element instanceof HTMLTextAreaElement) return "textbox";
    if (element instanceof HTMLInputElement) {
      if (["submit", "button", "reset"].includes(element.type)) return "button";
      if (element.type === "checkbox") return "checkbox";
      if (element.type === "radio") return "radio";
      return "textbox";
    }
    return element.tagName.toLowerCase();
  }

  function cssFallback(element) {
    if (element.id) return `#${CSS.escape(element.id)}`;
    const name = element.getAttribute("name");
    if (name) return `${element.tagName.toLowerCase()}[name="${CSS.escape(name)}"]`;
    const type = element.getAttribute("type");
    if (type) return `${element.tagName.toLowerCase()}[type="${CSS.escape(type)}"]`;
    return element.tagName.toLowerCase();
  }

  const controls = Array.from(
    document.querySelectorAll("button, a[href], input, select, textarea, [role=button], [role=link], [role=textbox]")
  )
    .filter(visible)
    .map((element, index) => ({
      ref: `c${index + 1}`,
      kind: "control",
      role: roleFor(element),
      name: accessibleName(element),
      enabled: !element.disabled,
      htmlName: element.getAttribute("name") ?? "",
      tag: element.tagName.toLowerCase(),
      css: cssFallback(element)
    }));

  const readable = [];
  for (const row of Array.from(document.querySelectorAll("tr"))) {
    const cells = Array.from(row.querySelectorAll(":scope > td, :scope > th")).filter(visible);
    if (cells.length < 2) continue;
    const rowLabel = cells[0]?.innerText.trim() ?? "";
    if (!rowLabel) continue;
    for (let column = 1; column < cells.length; column += 1) {
      const value = cells[column]?.innerText.trim() ?? "";
      if (!value) continue;
      readable.push({
        ref: `r${readable.length + 1}`,
        kind: "readable",
        role: "table_cell",
        name: `${rowLabel}: ${value}`,
        enabled: true,
        rowLabel,
        column
      });
    }
  }
  return {
    title: document.title,
    visibleText: document.body.innerText.slice(0, 12000),
    controls,
    readable
  };
})()
