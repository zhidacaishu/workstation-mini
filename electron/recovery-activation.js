function recoveredSettings(currentSettings, destinationPath) {
  return {
    ...currentSettings,
    vaultDir: destinationPath,
    syncEnabled: false
  };
}

async function activateRecoveredVault({ recovery, currentSettings, replaceRuntime }) {
  const activated = await recovery.activate();
  const nextSettings = recoveredSettings(currentSettings, activated.destinationPath);
  try {
    await replaceRuntime(nextSettings, currentSettings);
  } catch (error) {
    await recovery.failActivation().catch(() => {});
    throw error;
  }
  await recovery.completeActivation();
  return { activated, nextSettings };
}

module.exports = { activateRecoveredVault, recoveredSettings };
