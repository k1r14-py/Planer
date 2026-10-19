// После упаковки: на macOS подписываем приложение ad-hoc-подписью.
// Без подписи macOS на Apple Silicon считает приложение «повреждённым»; ad-hoc не требует
// аккаунта разработчика Apple — остаётся только разовое подтверждение «открыть от неизвестного разработчика».
const { execFileSync } = require("node:child_process");
const path = require("node:path");

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") return;
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  console.log(`  • ad-hoc подпись ${app}`);
  execFileSync("codesign", ["--force", "--deep", "--sign", "-", app], { stdio: "inherit" });
};
