#!/bin/sh
# Makes a private CA and a certificate for the `sql` service, once. The app and
# the setup trust that CA (NODE_EXTRA_CA_CERTS), so their SQL connections stay
# encrypted and the server is verified. Delete the certs volume to replace them.
set -eu
cd /certs
if [ -s ca.pem ] && [ -s sql.pem ] && [ -s sql.key ]; then
  echo "Certificates already exist."
  exit 0
fi
umask 077
openssl req -x509 -newkey rsa:3072 -nodes -days 3650 -subj "/CN=LMS self-host CA" -keyout ca.key -out ca.pem 2>/dev/null
openssl req -newkey rsa:3072 -nodes -subj "/CN=sql" -keyout sql.key -out sql.csr 2>/dev/null
printf 'subjectAltName=DNS:sql,DNS:localhost\nextendedKeyUsage=serverAuth\nkeyUsage=digitalSignature,keyEncipherment\n' > sql.ext
openssl x509 -req -in sql.csr -CA ca.pem -CAkey ca.key -CAcreateserial -days 825 -extfile sql.ext -out sql.pem 2>/dev/null
rm -f ca.key ca.srl sql.csr sql.ext
chown 10001:0 sql.key sql.pem
chmod 600 sql.key
chmod 644 sql.pem ca.pem
echo "Made a CA and a certificate for sql."
