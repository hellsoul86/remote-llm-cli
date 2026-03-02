package runtime

type CodexRunMode string

const (
	CodexRunModeExec   CodexRunMode = "exec"
	CodexRunModeResume CodexRunMode = "resume"
	CodexRunModeReview CodexRunMode = "review"
)

type CodexRunOptions struct {
	Mode       CodexRunMode `json:"mode,omitempty"`
	SessionID  string       `json:"session_id,omitempty"`
	ResumeLast bool         `json:"resume_last,omitempty"`

	Model         string   `json:"model,omitempty"`
	Profile       string   `json:"profile,omitempty"`
	Sandbox       string   `json:"sandbox,omitempty"`
	Config        []string `json:"config,omitempty"`
	Enable        []string `json:"enable,omitempty"`
	Disable       []string `json:"disable,omitempty"`
	AddDirs       []string `json:"add_dirs,omitempty"`
	Images        []string `json:"images,omitempty"`
	LocalProvider string   `json:"local_provider,omitempty"`
	Color         string   `json:"color,omitempty"`

	OSS               bool `json:"oss,omitempty"`
	FullAuto          bool `json:"full_auto,omitempty"`
	ProgressCursor    bool `json:"progress_cursor,omitempty"`
	SkipGitRepoCheck  bool `json:"skip_git_repo_check,omitempty"`
	Ephemeral         bool `json:"ephemeral,omitempty"`
	JSONOutput        bool `json:"json_output,omitempty"`
	ReviewUncommitted bool `json:"review_uncommitted,omitempty"`

	DangerouslyBypassApprovalsAndSandbox bool   `json:"dangerously_bypass_approvals_and_sandbox,omitempty"`
	OutputLastMessageFile                string `json:"output_last_message_file,omitempty"`
	ReviewBase                           string `json:"review_base,omitempty"`
	ReviewCommit                         string `json:"review_commit,omitempty"`
	ReviewTitle                          string `json:"review_title,omitempty"`
}
