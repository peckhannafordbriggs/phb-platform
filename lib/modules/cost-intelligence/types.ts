/** One execution of a workflow against one project. */
export type Run = {
  id: string;
  project: string;
  workflow: string;
  status: string;
  started: string;
};

/** A choice in a dropdown: the stored value and what a person reads. */
export type Option = { value: string; label: string };
