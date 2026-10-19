cask "agent-office" do
  arch arm: "arm64", intel: "x64"

  version "0.10.0"
  sha256 arm:   "2cd8f200398a5e07dd043b8659107f066594520a895b653e6aaa1b8dda54ca28",
         intel: "5990fcbb2e5728cf18892b171661d358cfbb57bdeec3793124d0ccc03f1d8106"

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
