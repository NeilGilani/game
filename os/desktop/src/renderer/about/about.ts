const q = new URLSearchParams(location.search);
document.getElementById("version")!.textContent =
  `Version ${q.get("v") ?? "?"}${q.get("b") ? ` (${q.get("b")})` : ""}`;
