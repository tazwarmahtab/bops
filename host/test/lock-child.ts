import { openStore } from "../state.ts";

const store = openStore(process.argv[2]);
await store.update((file) => {
  file.settings.runsOn = "cloud";
});
process.stdout.write("done\n");