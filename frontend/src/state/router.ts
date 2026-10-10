import { useEffect, useState } from "react";

export interface Route {
  path: string;
  segments: string[];
  query: URLSearchParams;
}

function parse(): Route {
  const raw = window.location.hash.replace(/^#/, "") || "/";
  const [path = "/", search = ""] = raw.split("?");
  return { path, segments: path.split("/").filter(Boolean), query: new URLSearchParams(search) };
}

export function navigate(path: string): void {
  if (window.location.hash !== `#${path}`) window.location.hash = path;
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(parse);
  useEffect(() => {
    const onChange = () => setRoute(parse());
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return route;
}
