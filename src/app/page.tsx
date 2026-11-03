import { redirect } from "next/navigation";

// The bare app address is what visitors get, so it opens the public job board
// (ats-project-scope.md §5.3). Staff go to /dashboard, which sends them to
// /sign-in first. A temporary (307) redirect, so browsers don't cache it if
// the home page changes later.
export default function Home() {
  redirect("/jobs");
}
