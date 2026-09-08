#!/usr/bin/env bash
# Duplo-clique (Mac/Linux) ou "sh start.sh" no terminal para jogar Ember localmente.
set -e
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js não encontrado."
  echo "Instale a versão 20 ou mais recente em https://nodejs.org e rode este arquivo de novo."
  read -r -p "Pressione Enter para sair..."
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "Instalando dependências (só na primeira vez, pode levar um minuto)..."
  npm install
fi

echo "Abrindo o jogo em http://localhost:8080 ..."
( sleep 3; open http://localhost:8080 2>/dev/null || xdg-open http://localhost:8080 2>/dev/null || true ) &

npm run dev
