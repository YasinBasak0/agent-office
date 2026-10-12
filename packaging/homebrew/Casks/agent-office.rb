cask "agent-office" do
  arch arm: "arm64", intel: "x64"

  version "0.8.4"
  sha256 arm:   "0e12b2b40a78565da9fdaabfa9a2052d5cee0502f8185847655e220ee56744de",
         intel: "60056bc7ae772baf31d201d3b8256e15e1557b393769ca5d67537cb90c18eb69"

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
