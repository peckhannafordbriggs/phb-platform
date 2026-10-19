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
- skill and project sync read SharePoint (folder-store.ts). Next: daily scheduled sync; measure project sync time on the full BID-DOC (one Graph request per folder)

Runs:
- worker in Azure: Container Apps Job resource in infra/main.bicep (KEDA Postgres scaler on queued cip_runs, --once), image build in deploy.yml, ANTHROPIC_API_KEY in Key Vault. Needs the platform owner's sign-off
- worker files: the project and skills are downloaded from SharePoint; outputs still go to the local CIP_PROJECTS_DIR. Next: upload to AI FILES in SharePoint (publishOutputs), which needs write
- fix docker for tools
- search: run results were placeholders and are gone; add them back with real search
- add a optional text field for new run 
- add optional file upload for new run
- setup hybrid agent runs (haiku for reads, sonnet only for thinking)
- find a cache storage solution (beyond the 5 min ) for checkpoints
- add cost saving methods
- logging for dev monitoring
- change ledger to show less commands and replace with human readable logs
- cache prompts and project history 
- edit skills
- allow model selection
- add feature to tailor responses & work based on resume
