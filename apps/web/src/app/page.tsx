import Link from "next/link";

export default function Home() {
  return (
    <div className="container mx-auto max-w-3xl px-4 py-6">
      <h1 className="text-2xl font-semibold mb-2">HEALOSBENCH</h1>
      <p className="text-muted-foreground mb-4">
        Eval harness for structured clinical extraction. Run a strategy across the 50-case
        dataset, score per field, and compare prompts head-to-head.
      </p>
      <ul className="grid gap-2 text-lg">
        <li>
          <Link className="underline" href="/runs">
            → Runs
          </Link>
        </li>
        <li>
          <Link className="underline" href="/runs/new">
            → Start a new run
          </Link>
        </li>
        <li>
          <Link className="underline" href="/runs/compare">
            → Compare two runs
          </Link>
        </li>
      </ul>
    </div>
  );
}
