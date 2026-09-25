import { Bar } from "../ui/Bar";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";
import { Label } from "../ui/Label";
import { Table } from "../ui/Table";
import { Node } from "./parts";

/** Title row every settings view opens with: heading, repo and branch, last Git check. */
function SettingsHeading() {
  return (
    <div className="mb-5">
      <Bar w={200} h={20} />
      <div className="mt-3 flex items-center gap-3">
        <Bar w={170} h={20} />
        <Bar w={150} h={8} />
      </div>
    </div>
  );
}

/** A skill's detail: versions on a track, changes waiting on main, the SKILL.md diff. */
function SkillDetail() {
  return (
    <Card className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <Bar w={220} h={18} />
        <Bar w={90} h={22} />
      </div>

      <div className="grid grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="flex flex-col items-center gap-2">
            <div className="flex w-full items-center">
              <div className="h-px flex-1 bg-[var(--neutral-200)]" />
              <Node size={14} />
              <div className="h-px flex-1 bg-[var(--neutral-200)]" />
            </div>
            <Bar w={48} h={8} />
          </div>
        ))}
      </div>

      <div>
        <div className="mb-3 flex items-center justify-between">
          <Bar w={200} h={10} />
          <Button w={100} />
        </div>
        <div className="flex flex-col gap-2">
          {Array.from({ length: 3 }, (_, i) => (
            <div key={i} className="flex items-center gap-3 rounded-[var(--radius-control)] border border-[var(--border)] p-3">
              <Bar w={56} h={8} />
              <Bar w="55%" h={9} />
              <div className="flex-1" />
              <Bar w={48} h={8} />
            </div>
          ))}
        </div>
      </div>

      <div className="rounded-[var(--radius-row)] bg-[var(--neutral-100)] p-4">
        <div className="flex flex-col gap-2">
          {[70, 55, 82, 40, 76, 62, 48, 88, 35].map((w, i) => (
            <Bar key={i} w={`${w}%`} h={7} />
          ))}
        </div>
      </div>
    </Card>
  );
}

/** Test against a fixture, then publish. */
function PublishRail() {
  return (
    <div className="flex flex-col gap-5">
      <Card>
        <Label>Test against a fixture</Label>
        <Bar w="70%" h={20} />
        <div className="flex flex-col gap-2.5">
          {Array.from({ length: 4 }, (_, i) => (
            <div key={i} className="mt-3 flex items-center gap-2.5">
              <span className="h-3.5 w-3.5 shrink-0 rounded-sm border border-[var(--neutral-300)]" />
              <Bar w="75%" h={8} />
            </div>
          ))}
        </div>
        <div className="mt-5"><Button w="100%" /></div>
      </Card>
      <Card>
        <Label>Publish</Label>
        <Bar w="90%" h={8} />
        <Bar w="70%" h={8} className="mt-1.5" />
        <div className="mt-5"><Button w="100%" /></div>
      </Card>
    </div>
  );
}

/** 1d: skills on the left, the selected skill in the middle, test and publish on the right. */
export function SkillCatalogView() {
  return (
    <>
      <SettingsHeading />
      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[16rem_minmax(0,1fr)_18rem]">
        <Card className="p-3">
          <div className="flex items-center justify-between px-2 pb-3 pt-1">
            <Bar w={50} h={8} />
            <Bar w={110} h={8} />
          </div>
          <div className="flex flex-col gap-1.5">
            {Array.from({ length: 5 }, (_, i) => (
              <div
                key={i}
                className={
                  "rounded-[var(--radius-control)] p-3 " +
                  (i === 1 ? "border border-[var(--neutral-300)] bg-[var(--neutral-50)]" : "")
                }
              >
                <div className="flex items-center justify-between">
                  <Bar w="55%" h={10} />
                  <Bar w={56} h={16} />
                </div>
                <Bar w="75%" h={7} className="mt-2" />
              </div>
            ))}
          </div>
        </Card>
        <SkillDetail />
        <PublishRail />
      </div>
    </>
  );
}

/** One skill, full width. */
export function SkillView() {
  return (
    <>
      <SettingsHeading />
      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1fr)_18rem]">
        <SkillDetail />
        <PublishRail />
      </div>
    </>
  );
}

/** Workflows, Access & roles, Usage & cost: a heading, optional stats, a table. */
export function SettingsTableView({
  cols,
  rows = 6,
  stats = 0,
}: {
  cols: (number | string)[];
  rows?: number;
  stats?: number;
}) {
  return (
    <>
      <SettingsHeading />
      {stats > 0 && (
        <div className="mb-5 grid grid-cols-2 gap-5 md:grid-cols-4">
          {Array.from({ length: stats }, (_, i) => (
            <Card key={i}>
              <Bar w={80} h={8} />
              <Bar w={96} h={26} className="mt-3" />
            </Card>
          ))}
        </div>
      )}
      <Card>
        <Table rows={rows} cols={cols} />
      </Card>
    </>
  );
}
