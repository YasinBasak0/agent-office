cask "agent-office" do
  arch arm: "arm64", intel: "x64"

  version "0.8.7"
  sha256 arm:   "54f89cf68ec3b12ca0d1a4d4f85bbadc2b27a4dd075e9a739c6f3fbe38898b4b",
         intel: "ca6c98ed546cb72cdca0ec9ccddeff67c24a1ffed49b7b9a5b616f9dc3f5c415"

  url "https://github.com/isisever/agent-office/releases/download/v#{version}/AgentOffice-#{version}-#{arch}.dmg"
  name "Agent Office"
  desc "Pixel-art office for Claude Code agents, with a terminal per project"
  homepage "https://github.com/isisever/agent-office"

  livecheck do
    url :url
    strategy :github_latest
  end

  auto_updates true
  depends_on macos: :monterey

  app "Agent Office.app"

  zap trash: [
    "~/.claude/agent-office",
    "~/Library/Application Support/Agent Office",
    "~/Library/Preferences/io.github.isisever.agentoffice.plist",
    "~/Library/Saved Application State/io.github.isisever.agentoffice.savedState",
  ]

  caveats <<~EOS
    Agent Office runs the Claude Code CLI; install it first if needed:
      https://code.claude.com

  EOS
end
