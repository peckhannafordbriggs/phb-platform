"use client";

import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";
import type { CoilType, FpBuilding } from "@/lib/modules/freeze-protection/types";
import { COIL_LABEL } from "@/lib/modules/freeze-protection/vocab";
import { call } from "../client";
import { FieldLabel, INPUT } from "../ui/Field";
import { Button, Card, Label } from "../ui/kit";

/**
 * Adds lines from the mechanical equipment schedule. Stays open after each one,
 * keeping the building, because a schedule is entered one unit after another.
 * Opened by `?new=equipment`.
 */
export function EquipmentForm({
  buildings,
  defaultBuildingId,
  doneHref,
}: {
  buildings: FpBuilding[];
  /** The building the switcher is showing, if one. */
  defaultBuildingId: string | null;
  doneHref: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [buildingId, setBuildingId] = useState(defaultBuildingId ?? buildings[0]?.id ?? "");
  const [tag, setTag] = useState("");
  const [equipmentType, setEquipmentType] = useState("");
  const [areaServed, setAreaServed] = useState("");
  const [coil, setCoil] = useState<CoilType | "">("");
  const [error, setError] = useState<string | null>(null);
  const [added, setAdded] = useState<string[]>([]);
  const tagRef = useRef<HTMLInputElement>(null);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      const r = await call<{ tag: string }>("POST", "/equipment", {
        buildingId,
        tag,
        equipmentType: equipmentType || null,
        areaServed: areaServed || null,
        coil: coil || null,
      });
      if (!r.ok) return setError(r.message);
      setAdded([r.data.tag, ...added]);
      setTag("");
      setAreaServed("");
      setCoil("");
      tagRef.current?.focus();
      router.refresh();
    });
  }

  return (
    <Card className="shrink-0">
      <div className="flex items-baseline justify-between gap-3">
        <Label>Add from the equipment schedule</Label>
        {added.length > 0 && (
          <p className="truncate text-[0.75rem] text-[var(--muted)]">
            Added <span className="font-mono">{added.slice(0, 6).join(", ")}</span>
            {added.length > 6 ? ` and ${added.length - 6} more` : ""}
          </p>
        )}
      </div>
      <form onSubmit={submit} className="grid grid-cols-1 items-end gap-3 sm:grid-cols-2 lg:grid-cols-[minmax(0,1fr)_8rem_minmax(0,1fr)_minmax(0,1.4fr)_minmax(0,1fr)_auto_auto]">
        <FieldLabel label="Building">
          <select value={buildingId} onChange={(e) => setBuildingId(e.target.value)} className={INPUT}>
            {buildings.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        </FieldLabel>
        <FieldLabel label="Tag">
          <input ref={tagRef} required autoFocus value={tag} onChange={(e) => setTag(e.target.value)} className={INPUT + " font-mono"} placeholder="AHU-1" />
        </FieldLabel>
        <FieldLabel label="Equipment type">
          <input value={equipmentType} onChange={(e) => setEquipmentType(e.target.value)} className={INPUT} placeholder="AHU, RTU, MAU…" />
        </FieldLabel>
        <FieldLabel label="Area served">
          <input value={areaServed} onChange={(e) => setAreaServed(e.target.value)} className={INPUT} />
        </FieldLabel>
        <FieldLabel label="Coil">
          <select value={coil} onChange={(e) => setCoil(e.target.value as CoilType | "")} className={INPUT}>
            <option value="">Not answered</option>
            {(Object.keys(COIL_LABEL) as CoilType[]).map((c) => (
              <option key={c} value={c}>
                {c === "none" ? "No coil" : COIL_LABEL[c]}
              </option>
            ))}
          </select>
        </FieldLabel>
        <Button type="submit" variant="primary" disabled={pending || buildingId === ""}>
          Add
        </Button>
        <Button href={doneHref}>Done</Button>
      </form>
      {error && <p className="mt-2 text-[0.8125rem] text-[var(--phb-maroon)]">{error}</p>}
    </Card>
  );
}
