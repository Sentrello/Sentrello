import { SignJWT, importPKCS8 } from "jose";

const tier = (process.argv[2] as "free" | "pro") ?? "pro";
const modules = (process.argv[3] ?? "").split(",").filter(Boolean);

const priv = await importPKCS8(
  await Bun.file("secrets/license_private.pem").text(),
  "EdDSA",
);
const token = await new SignJWT({
  license_id: "dev",
  instance_id: process.env.SENTRELLO_INSTANCE_ID ?? "dev-instance",
  tier,
  modules,
  seats: 20,
  grace_until: null,
})
  .setProtectedHeader({ alg: "EdDSA" })
  .setIssuer("sentrello.com")
  .setIssuedAt()
  .setExpirationTime("72h")
  .sign(priv);

await Bun.write("secrets/license_token.jwt", token);
console.log(
  `Minted dev ${tier} token (modules: ${modules.join(", ") || "none"}) -> secrets/license_token.jwt`,
);
