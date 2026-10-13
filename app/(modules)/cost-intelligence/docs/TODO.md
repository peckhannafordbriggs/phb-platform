Searchbar:
- add "/" functionality so user can type "/" anywhere to get search capabilities
- add real-time search

Jobs:
- add jobs page to track all projects and their respective runs
- have config for each job (inputs dir, output dir)
- display recent runs for each job and history of decisions etc etc

Settings:
- remove placeholders
- skill catalog: show when main has unpublished changes, and a publish flow (acceptance checks against a fixture, then publish). Without it the PCE cannot tell a skill is behind its live tag or ship a new version from the platform
- search: skill results still come from PLACEHOLDER_SKILLS, so they link to ids the real catalog 404s; point it at cip_skills
- skill sync: SharePoint reader once Sites.Selected is granted (replace readSkillsFolder in skill-sync.ts), then the daily scheduled sync
- project sync: Graph reader once Sites.Selected is granted (replace readProjectsFolder and listProjectFiles in project-sync.ts), then the daily scheduled sync

Runs:
- worker in Azure: Container Apps Job resource in infra/main.bicep (KEDA Postgres scaler on queued cip_runs, --once), image build in deploy.yml, ANTHROPIC_API_KEY in Key Vault. Needs the platform owner's sign-off
- worker files: Graph download of the project and upload to AI FILES once Sites.Selected is granted (buildWorkspace, publishOutputs)
- LibreOffice in Dockerfile.cip-worker when phb-state-form is piloted
- pilot skill: run pursuit-intake end to end and adjust it where it assumes Cowork (device_bash, connected folders)
- usage page: real spend from cip_runs.cost_usd
- search: run results were placeholders and are gone; add them back with real search
