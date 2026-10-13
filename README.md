# Wallpaper PKG Extractor

Aplicativo desktop em Electron para extrair imagens e texturas de arquivos `.pkg` do Wallpaper Engine.

![Wallpaper PKG Extractor Screenshot](build/screenshot.png)

## O que faz

- Localiza e escaneia automaticamente os wallpapers instalados na sua biblioteca Steam Workshop (ou pasta customizada).
- Descompacta e decodifica formatos nativos `.pkg` e `.tex` (DXT1, DXT3, DXT5, RGBA, LZ4) sem ferramentas externas.
- Permite buscar por nome e ordenar a grade de wallpapers.
- Salva os arquivos extraídos organizados em subpastas por wallpaper.
- Suporta redimensionamento inteligente (apenas redução, nunca distorce ou amplia desnecessariamente).
- Filtro para ignorar texturas secundárias (máscaras, partículas e efeitos) ou extrair tudo.
- Pré-visualização com carregamento dinâmico e cancelamento de extração a qualquer momento.

## Download

Baixe a versão executável mais recente na aba [Releases](https://github.com/ryanborge/extrator-de-pkg/releases/latest).

> **Aviso do Windows SmartScreen:**  
> Por ser um executável independente e sem certificado digital pago, o Windows pode exibir uma tela azul de aviso.  
> Para executar normalmente, clique em **"Mais informações"** e depois em **"Executar assim mesmo"**.

## Como rodar a partir do código

Pré-requisito: Node.js (versão 20 ou superior).

```bash
# 1. Instalar dependências
npm install

# 2. Executar testes
npm test

# 3. Iniciar o aplicativo
npm start
```

## Como gerar o executável (.exe)

Certifique-se de que o ícone `build/icon.ico` (256x256) está presente:

```bash
npm run dist
```

Os instaladores (`.exe` NSIS e versão Portable) serão gerados dentro do diretório `dist/`.
