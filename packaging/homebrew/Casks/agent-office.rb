cask "agent-office" do
  arch arm: "arm64", intel: "x64"

  version "0.10.2"
  sha256 arm:   "2d6bfc67168e6af548566c27fbc019ba4dfd1a6f8892fcc62ce8ec473716af23",
         intel: "e6e32cf31a5cc4e4f71b6cf91da35b9367c51f5b50a12d1ee40c3c54f92c7475"

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
