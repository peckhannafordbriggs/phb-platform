-- Set by Continue on a failed run: the message the worker resumes the agent's
-- session with, once, instead of an answer. Null otherwise.
ALTER TABLE "cip_runs" ADD COLUMN "resume_prompt" TEXT;
