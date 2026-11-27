#!/bin/sh
# /etc/letsencrypt/renewal-hooks/deploy/coturn.sh  (root:root, chmod 755)
#
# certbot runs every deploy hook after ANY certificate on this server is renewed, with RENEWED_LINEAGE set
# to that certificate's folder. This hook acts only for the dehlapakad.tech certificate: it gives coturn
# (user turnserver, which cannot read /etc/letsencrypt) its own copy and restarts coturn only if it runs.
#
# First run by hand (before coturn is enabled):
#   sudo RENEWED_LINEAGE=/etc/letsencrypt/live/dehlapakad.tech /etc/letsencrypt/renewal-hooks/deploy/coturn.sh
set -eu

LINEAGE="${RENEWED_LINEAGE:-}"
case "$(basename "$LINEAGE")" in
  dehlapakad.tech|dehlapakad.tech-[0-9]*) ;;   # this site's certificate (certbot may add -0001 on re-issue)
  *) exit 0 ;;                                  # another site's certificate: nothing to do
esac

DEST=/etc/turnserver/certs
install -d -o root -g turnserver -m 750 "$DEST"
# Write to temporary names, then rename, so coturn never sees a half-written key.
install -o turnserver -g turnserver -m 644 "$LINEAGE/fullchain.pem" "$DEST/.fullchain.pem.new"
install -o turnserver -g turnserver -m 600 "$LINEAGE/privkey.pem"  "$DEST/.privkey.pem.new"
mv -f "$DEST/.fullchain.pem.new" "$DEST/fullchain.pem"
mv -f "$DEST/.privkey.pem.new"  "$DEST/privkey.pem"

# Restart only if coturn is running (a renewal must not start a stopped relay). The restart drops calls
# that are currently relayed (players can rejoin voice); renewals happen about every 60 days.
if systemctl is-active --quiet coturn; then
  systemctl restart coturn || { echo "coturn restart failed after certificate renewal" >&2; exit 1; }
fi
