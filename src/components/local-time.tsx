"use client";

// A time in the viewer's browser time zone and locale (ats-project-scope.md
// I6, §8). The server can't know the browser's zone, so the server render
// (and hydration) shows UTC, and the browser then switches to local time.
import { useSyncExternalStore } from "react";

const subscribe = () => () => {};

export function LocalTime({ value, dateOnly = false }: { value: string; dateOnly?: boolean }) {
  const inBrowser = useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );
  const date = new Date(value);
  const options: Intl.DateTimeFormatOptions = dateOnly ? { dateStyle: "medium" } : { dateStyle: "medium", timeStyle: "short" };
  const text = inBrowser ? date.toLocaleString(undefined, options) : `${date.toLocaleString("en-GB", { ...options, timeZone: "UTC" })} UTC`;
  return <time dateTime={value}>{text}</time>;
}
