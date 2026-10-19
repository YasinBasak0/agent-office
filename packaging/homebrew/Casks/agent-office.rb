cask "agent-office" do
  arch arm: "arm64", intel: "x64"

  version "0.9.2"
  sha256 arm:   "6838458c67d3096f94d3fd1766318875e4f894c6f09b6e4eb56e8c252e72344b",
         intel: "e5bc9b1a6d5782fd3fd9fa088dc365bc5c7e40f00d6c288811d36604bcebeba1"

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
