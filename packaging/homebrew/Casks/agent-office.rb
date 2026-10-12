cask "agent-office" do
  arch arm: "arm64", intel: "x64"

  version "0.8.5"
  sha256 arm:   "8d3f7381776f6e064125e094ecf9dc823699554eddbc2e1e4237b385517795fc",
         intel: "3433010e580eb10b22de5a555123c8c6d8e477f53613dd5a96ae68584c0dea21"

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
