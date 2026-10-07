export function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var ${name}`);
  return v;
}

export const repo = () => {
  const [owner, name] = env("GITHUB_REPO").split("/");
  return { owner, repo: name, url: `https://github.com/${owner}/${name}` };
};
