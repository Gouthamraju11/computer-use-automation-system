(function captureHumanActions() {
  const bindingName = __BINDING_NAME_JSON__;

  function targetSummary(rawTarget) {
    if (!(rawTarget instanceof Element)) return { element: "unknown" };
    return {
      tag: rawTarget.tagName.toLowerCase(),
      role: rawTarget.getAttribute("role") ?? "",
      name:
        rawTarget.getAttribute("aria-label") ??
        rawTarget.innerText?.trim().slice(0, 120) ??
        rawTarget.getAttribute("name") ??
        ""
    };
  }

  document.addEventListener(
    "click",
    function onHumanClick(event) {
      const callback = window[bindingName];
      callback?.({ kind: "click", target: targetSummary(event.target) });
    },
    true
  );
  document.addEventListener(
    "change",
    function onHumanInput(event) {
      const callback = window[bindingName];
      callback?.({ kind: "input", target: targetSummary(event.target), value: "[REDACTED]" });
    },
    true
  );
})()
