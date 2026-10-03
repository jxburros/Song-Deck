// Song Deck plugin: registers a community genre profile (spec §14, §57 "Genre Profiles").
export async function register(api) {
  const res = await fetch(api.fileUrl('profile.json'));
  if (!res.ok) throw new Error(`Could not load profile.json (${res.status})`);
  const profile = await res.json();
  api.registerGenre(profile);
  api.log(`registered genre ${profile.name}`);
}
