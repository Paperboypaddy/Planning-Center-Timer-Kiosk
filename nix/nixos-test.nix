# Eval-only smoke check: assert the module wires control, Caddy, and Cage.
# Full VM boots need KVM; this stays fast in CI / nested environments.
{
  self,
  pkgs,
  lib ? pkgs.lib,
}:

let
  system = pkgs.stdenv.hostPlatform.system;
  eval = import "${pkgs.path}/nixos/lib/eval-config.nix" {
    inherit system;
    modules = [
      self.nixosModules.planningcenter-timer-kiosk
      {
        networking.hostName = "kiosk";
        services.planningcenter-timer-kiosk = {
          enable = true;
          enableCec = false;
        };
        # Minimal disk/boot so eval does not require hardware modules.
        boot.loader.grub.enable = false;
        fileSystems."/" = {
          device = "nodev";
          fsType = "tmpfs";
        };
        system.stateVersion = lib.trivial.release;
      }
    ];
  };

  cfg = eval.config;
  ctrl = cfg.systemd.services.planningcenter-timer-kiosk;
  cage = cfg.systemd.services."cage-tty1";
in

assert cfg.services.planningcenter-timer-kiosk.enable;
assert cfg.services.caddy.enable;
assert cfg.services.cage.enable;
assert cfg.services.cage.user == "kiosk";
assert builtins.elem "multi-user.target" ctrl.wantedBy;
assert ctrl.serviceConfig.User == "kiosk";
assert builtins.any (e: lib.hasPrefix "KIOSK_UPDATE_SCRIPT=" e) (
  lib.toList ctrl.serviceConfig.Environment
);
assert cage != null;
assert cfg.networking.firewall.allowedTCPPorts == [ 443 ];
assert cfg.services.avahi.enable;

pkgs.runCommand "planningcenter-timer-kiosk-nixos-eval" { } ''
  echo "module ok: control + caddy + cage wired"
  touch "$out"
''
