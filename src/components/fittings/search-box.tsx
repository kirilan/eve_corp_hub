/** Plain GET form: the query lives in the URL, so results are linkable and work without JavaScript. */
export function SearchBox({ defaultValue, hidden }: { defaultValue?: string; hidden?: Record<string, string> }) {
  return (
    <form className="flex gap-2">
      {Object.entries(hidden ?? {}).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      <input
        name="q"
        defaultValue={defaultValue}
        placeholder="Search by fit or ship name"
        className="w-full max-w-sm rounded border border-border bg-background px-3 py-1.5 text-sm"
      />
      <button className="rounded border border-border px-3 py-1.5 text-sm hover:border-accent">Search</button>
    </form>
  );
}
