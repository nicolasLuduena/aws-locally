import { useEffect, useState } from "react";

export type Route =
  | { view: "home" }
  | { view: "lesson"; moduleId: string; lessonId: string }
  | { view: "quiz"; moduleId: string }
  | { view: "module"; moduleId: string };

export function parse(hash: string): Route {
  const p = hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  if (p[0] === "m" && p[1] && p[2] === "quiz") return { view: "quiz", moduleId: p[1] };
  if (p[0] === "m" && p[1] && p[2]) return { view: "lesson", moduleId: p[1], lessonId: p[2] };
  if (p[0] === "m" && p[1]) return { view: "module", moduleId: p[1] };
  return { view: "home" };
}

export function href(r: Route): string {
  switch (r.view) {
    case "home":
      return "#/";
    case "module":
      return `#/m/${r.moduleId}`;
    case "quiz":
      return `#/m/${r.moduleId}/quiz`;
    case "lesson":
      return `#/m/${r.moduleId}/${r.lessonId}`;
  }
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parse(location.hash));
  useEffect(() => {
    const h = () => setRoute(parse(location.hash));
    window.addEventListener("hashchange", h);
    return () => window.removeEventListener("hashchange", h);
  }, []);
  return route;
}
