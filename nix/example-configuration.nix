# Minimal host configuration for a Planning Center Timer Kiosk on NixOS.
#
# With a flake input named `kiosk` (prefer a release tag in production):
#
#   inputs.kiosk.url = "github:Paperboypaddy/Planning-Center-Timer-Kiosk/YYYY.M.D";
#
#   {
#     imports = [ inputs.kiosk.nixosModules.default ];
#     services.planningcenter-timer-kiosk.enable = true;
#   }
#
# Or copy this file and adjust hostname / secrets.

{ ... }:

{
  networking.hostName = "kiosk";

  services.planningcenter-timer-kiosk = {
    enable = true;
    # Optional: EnvironmentFile with KIOSK_PCO_API_KEY=…
    # pcoApiKeyFile = "/run/secrets/pco-api-key";
  };

  # First boot: open https://kiosk.local (or the machine IP) and create the
  # admin account. Updates: bump the flake input tag + nixos-rebuild — not
  # the panel.
}
