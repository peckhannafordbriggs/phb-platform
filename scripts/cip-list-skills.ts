import "./load-env";
import {
  SkillSourceError,
  skillSourceFromEnv,
} from "../lib/modules/cost-intelligence/skill-source";

/**
 * Prints what the skill sync would see, without touching the database.
 *
 *   npx tsx scripts/cip-list-skills.ts
 *
 * Reads CIP_SKILLS_DIR from .env.local.
 */
async function main(): Promise<void> {
  const source = skillSourceFromEnv();
  const { skills, errors } = await source.listSkills();

  console.table(
    skills.map((s) => ({
      folder: s.folderName,
      name: s.name,
      version: s.version,
      lastModified: s.lastModified.toISOString().slice(0, 10),
      description: s.description.length > 60 ? `${s.description.slice(0, 57)}...` : s.description,
    })),
  );

  console.log(`${skills.length} skill(s) read from ${source.kind} source.`);

  if (errors.length > 0) {
    console.log(`${errors.length} folder(s) could not be read:`);
    for (const e of errors) console.log(`  ${e.folderName}: ${e.reason}`);
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  if (error instanceof SkillSourceError) {
    console.error(`[${error.code}] ${error.message}`);
  } else {
    console.error(error);
  }
  process.exitCode = 1;
});
