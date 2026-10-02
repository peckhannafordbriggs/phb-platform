import { ArrowLeft, Plus } from "lucide-react";
import { Button } from "./ui/Button";
import { SearchBar } from "./ui/searchbar";

type Props = { canAdminister?: boolean };

/** Search and New run. With the launcher open, New run is the button that closes it. */
export function NewRunActions({ launcherOpen = false, canAdminister = false }: Props & { launcherOpen?: boolean }) {
  return (
    <>
      <SearchBar canAdminister={canAdminister} />
      <Button variant="primary" href={launcherOpen ? "/cost-intelligence" : "/cost-intelligence?new=1"}>
        <Plus size={16} aria-hidden="true" />
        New run
      </Button>
    </>
  );
}

/** Search and Back to the runs list, for a single run. */
export function RunActions({ canAdminister = false }: Props) {
  return (
    <>
      <SearchBar canAdminister={canAdminister} />
      <Button variant="primary" href="/cost-intelligence">
        <ArrowLeft size={16} aria-hidden="true" />
        Back
      </Button>
    </>
  );
}
