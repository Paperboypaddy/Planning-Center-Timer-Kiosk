{
  config,
  lib,
  pkgs,
  ...
}:

let
  cfg = config.services.planningcenter-timer-kiosk;
  inherit (lib)
    mkEnableOption
    mkIf
    mkOption
    mkPackageOption
    types
    ;

  stateDir = cfg.stateDir;
  controlPort = 3001;
  cdpPort = 9222;

  hostName = config.networking.hostName;
  certHost = "${hostName}.local";

  certFile = "${stateDir}/tls/kiosk-cert.pem";
  keyFile = "${stateDir}/tls/kiosk-key.pem";

  browserWrapper = pkgs.writeShellScript "planningcenter-timer-kiosk-cage" ''
    set -euo pipefail
    # Cage starts the client with cwd=/; Chromium hangs unless we cd first.
    cd "$HOME"
    exec ${lib.getExe' cfg.package "planningcenter-timer-kiosk-browser"} --kiosk
  '';
in
{
  options.services.planningcenter-timer-kiosk = {
    enable = mkEnableOption "Planning Center Timer Kiosk (Cage/Wayland + control server + Caddy TLS)";

    package = mkPackageOption pkgs "planningcenter-timer-kiosk" { };

    user = mkOption {
      type = types.str;
      default = "kiosk";
      description = "User that runs the control server and the Cage/Chromium session.";
    };

    group = mkOption {
      type = types.str;
      default = "kiosk";
      description = "Primary group for the kiosk user.";
    };

    stateDir = mkOption {
      type = types.path;
      default = "/var/lib/planningcenter-timer-kiosk";
      description = "Persistent state (config.json, Chromium profile, TLS certs).";
    };

    panelPort = mkOption {
      type = types.port;
      default = 443;
      description = "HTTPS port for the control panel (Caddy).";
    };

    openFirewall = mkOption {
      type = types.bool;
      default = true;
      description = "Open the panel port in the firewall.";
    };

    enableAvahi = mkOption {
      type = types.bool;
      default = true;
      description = "Enable Avahi so the panel is reachable at https://<hostname>.local.";
    };

    enableCec = mkOption {
      type = types.bool;
      default = true;
      description = "Install libcec (cec-client) and add the kiosk user to the video group for HDMI-CEC TV power.";
    };

    pcoApiKeyFile = mkOption {
      type = types.nullOr types.path;
      default = null;
      description = ''
        Optional EnvironmentFile (e.g. agenix secret) containing
        `KIOSK_PCO_API_KEY=…` for the Planning Center importer.
      '';
    };
  };

  config = mkIf cfg.enable {
    assertions = [
      {
        assertion = cfg.user != "root";
        message = "services.planningcenter-timer-kiosk.user must not be root";
      }
    ];

    users.users.${cfg.user} = {
      isNormalUser = true;
      description = "Planning Center Kiosk";
      group = cfg.group;
      home = "/home/${cfg.user}";
      createHome = true;
      extraGroups = lib.optionals cfg.enableCec [ "video" ];
    };
    users.groups.${cfg.group} = { };

    # Immutable store: panel GitHub apply-updates are disabled (empty script).
    # Check-for-updates still works; apply via nixos-rebuild / flake bump.
    systemd.services.planningcenter-timer-kiosk = {
      description = "Planning Center Timer Kiosk control server";
      after = [ "network.target" ];
      wantedBy = [ "multi-user.target" ];
      serviceConfig = {
        Type = "simple";
        User = cfg.user;
        Group = cfg.group;
        WorkingDirectory = stateDir;
        ExecStart = lib.getExe cfg.package;
        Restart = "always";
        RestartSec = "5";
        PrivateTmp = true;
        # Scheduled reboot uses `sudo -n systemctl reboot` (narrow sudoers rule).
        StateDirectory = lib.mkIf (lib.hasPrefix "/var/lib/" stateDir) (
          lib.removePrefix "/var/lib/" stateDir
        );
        Environment = [
          "KIOSK_PORT=${toString controlPort}"
          "KIOSK_CONFIG=${stateDir}/config.json"
          "KIOSK_CDP_HOST=127.0.0.1"
          "KIOSK_CDP_PORT=${toString cdpPort}"
          "KIOSK_UPDATE_SCRIPT="
        ];
        EnvironmentFile = lib.mkIf (cfg.pcoApiKeyFile != null) [ cfg.pcoApiKeyFile ];
      };
    };

    # TLS certs for Caddy (self-signed, generated once into stateDir/tls).
    systemd.services.planningcenter-timer-kiosk-cert = {
      description = "Generate Planning Center Kiosk TLS certificate";
      wantedBy = [ "multi-user.target" ];
      before = [ "caddy.service" ];
      after = [ "local-fs.target" ];
      path = [
        cfg.package
        pkgs.coreutils
        pkgs.hostname
      ];
      unitConfig.ConditionPathExists = "!${certFile}";
      serviceConfig = {
        Type = "oneshot";
        RemainAfterExit = true;
        ExecStart = pkgs.writeShellScript "planningcenter-timer-kiosk-cert" ''
          set -euo pipefail
          mkdir -p ${lib.escapeShellArg "${stateDir}/tls"}
          ${lib.getExe' cfg.package "planningcenter-timer-kiosk-gen-cert"} \
            ${lib.escapeShellArg "${stateDir}/tls"} \
            ${lib.escapeShellArg certHost}
          chown caddy:caddy ${lib.escapeShellArg certFile} ${lib.escapeShellArg keyFile}
          chmod 644 ${lib.escapeShellArg certFile}
          chmod 600 ${lib.escapeShellArg keyFile}
        '';
      };
    };

    systemd.tmpfiles.rules = [
      "d ${stateDir} 0750 ${cfg.user} ${cfg.group} -"
      "d ${stateDir}/chromium-profile 0750 ${cfg.user} ${cfg.group} -"
      "d ${stateDir}/tls 0750 root caddy -"
    ];

    services.cage = {
      enable = true;
      user = cfg.user;
      program = browserWrapper;
      environment = {
        WLR_LIBINPUT_NO_DEVICES = "1";
        KIOSK_CHROMIUM = lib.getExe pkgs.chromium;
        KIOSK_PROFILE_DIR = "${stateDir}/chromium-profile";
        KIOSK_URL = "http://127.0.0.1:${toString controlPort}/nowplaying";
        KIOSK_DEBUG_PORT = toString cdpPort;
        # Cage sets up a Wayland session; make the launcher skip X11 wait/xset.
        XDG_SESSION_TYPE = "wayland";
      };
    };

    # Prefer starting Chromium after the control server is up.
    systemd.services."cage-tty1" = {
      after = [
        "planningcenter-timer-kiosk.service"
        "network.target"
      ];
      wants = [ "planningcenter-timer-kiosk.service" ];
    };

    services.caddy = {
      enable = true;
      virtualHosts.":${toString cfg.panelPort}" = {
        extraConfig = ''
          tls ${certFile} ${keyFile}
          reverse_proxy 127.0.0.1:${toString controlPort} {
            flush_interval -1
          }
        '';
      };
    };

    systemd.services.caddy = {
      after = [
        "planningcenter-timer-kiosk-cert.service"
        "planningcenter-timer-kiosk.service"
      ];
      wants = [ "planningcenter-timer-kiosk-cert.service" ];
    };

    networking.firewall.allowedTCPPorts = mkIf cfg.openFirewall [ cfg.panelPort ];

    services.avahi = mkIf cfg.enableAvahi {
      enable = true;
      nssmdns4 = true;
      publish = {
        enable = true;
        addresses = true;
        workstation = true;
      };
    };

    environment.systemPackages = lib.optionals cfg.enableCec [ pkgs.libcec ];

    security.sudo.extraRules = [
      {
        users = [ cfg.user ];
        commands = [
          {
            command = "/run/current-system/sw/bin/systemctl reboot";
            options = [ "NOPASSWD" ];
          }
        ];
      }
    ];
  };
}
