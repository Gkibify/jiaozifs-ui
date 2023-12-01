import {Button,Modal,Form,Container,Row,Col,ProgressBar} from "react-bootstrap";
import React, {useCallback, useEffect, useState } from "react";
import {useDropzone} from "react-dropzone";
import {objects, staging,uploadWithProgress} from "../../../../../lib/api";
import {CheckboxIcon, UploadIcon, XIcon} from "@primer/octicons-react";
import {humanSize} from "../../../../../lib/components/repository/tree";
import pMap from "p-map";
import {
    AlertError,
    Warnings
} from "../../../../../lib/components/controls";
import {RefTypeBranch} from "../../../../../constants";
import { InitialState, UploadButtonProps, UploadCandidateProps, UploadFileProps, UploadResult, _File } from "../../../interface/repo_interface";

const MAX_PARALLEL_UPLOADS = 5;

function extractChecksumFromResponse(response:UploadResult){
    if (response.contentMD5) {
      // convert base64 to hex
      const raw = atob(response.contentMD5)
      let result = '';
      for (let i = 0; i < raw.length; i++) {
        const hex = raw.charCodeAt(i).toString(16);
        result += (hex.length === 2 ? hex : '0' + hex);
      }
      return result;
    }
  
    if (response.etag) {
      // drop any quote and space
      return response.etag.replace(/[" ]+/g, "");
    }
    return ""
  }
  
const destinationPath = (path: string | undefined, file: _File) => {
    return `${path ? path : ""}${file.path.replace(/\\/g, '/').replace(/^\//, '')}`;
  };
  
  const UploadCandidate: React.FC<UploadCandidateProps> = ({ repo, reference, path, file, state, onRemove = null }) => {
    const fpath = destinationPath(path, file)
    let uploadIndicator = null;
    if (state && state.status === "uploading") {
      uploadIndicator = <ProgressBar variant="success" now={state.percent}/>
    } else if (state && state.status === "done") {
      uploadIndicator = <strong><CheckboxIcon/></strong>
    } else if (!state && onRemove !== null) {
      uploadIndicator = (
        <a  href="#" onClick={ e => {
          e.preventDefault()
          onRemove()
        }}>
          <XIcon />
        </a>
      );
    }
    return (
      <Container>
        <Row className={`upload-item upload-item-${state ? state.status : "none"}`}>
          <Col>
            <span className="path">
              jzfs://{repo.id}/{reference.id}/{fpath}
            </span>
          </Col>
          <Col xs md="2">
            <span className="size">
              {humanSize(file.size)}
            </span>
          </Col>
          <Col xs md="1">
            <span className="upload-state">
              {uploadIndicator ? uploadIndicator : <></>}
            </span>
          </Col>
        </Row>
      </Container>
    )
  };
  
const uploadFile:UploadFileProps = async (config, repo, reference, path, file, onProgress) => {
    const fpath = destinationPath(path, file);
    if (config.pre_sign_support_ui) {
        let additionalHeaders;
        if (config.blockstore_type === "azure") {
            additionalHeaders = { "x-ms-blob-type": "BlockBlob" }
        }
      const getResp = await staging.get(repo.id, reference.id, fpath, config.pre_sign_support_ui);
      const uploadResponse = await uploadWithProgress(getResp.presigned_url, file, 'PUT', onProgress, additionalHeaders)
      if (uploadResponse.status >= 400) {
        throw new Error(`Error uploading file: HTTP ${status}`)
      }
      const checksum = extractChecksumFromResponse(uploadResponse)
      await staging.link(repo.id, reference.id, fpath, getResp, checksum, file.size, file.type);
    } else {
      await objects.upload(repo.id, reference.id, fpath, file, onProgress);
    }
  };
  
export const UploadButton: React.FC<UploadButtonProps> = ({config, repo, reference, path, onDone, onClick, onHide, show = false}) => {
    const initialState: InitialState = {
      inProgress: false,
      error : null,
      done: false,
    };
    const [currentPath, setCurrentPath] = useState(path);
    const [uploadState, setUploadState] = useState(initialState);
    const [files, setFiles] = useState<_File[]>([]);
    const [fileStates, setFileStates] = useState({});
    const [abortController, setAbortController] = useState<AbortController | null>(null)
    const onDrop = useCallback((acceptedFiles:_File[]) => {
      setFiles([...acceptedFiles])
    }, [files])
  
    const { getRootProps, getInputProps, isDragAccept } = useDropzone({onDrop})
  
    if (!reference || reference.type !== RefTypeBranch) return <></>;
  
    const hide = () => {
      if (uploadState.inProgress) {
        if (abortController !== null) {
            abortController.abort()
        } else {
          return
        }
      }
      setUploadState(initialState);
      setFileStates({});
      setFiles([]);
      setCurrentPath(path);
      setAbortController(null)
      onHide();
    };
  
    useEffect(() => {
      setCurrentPath(path)
    }, [path])
  
    const upload = async () => {
      if (files.length < 1) {
        return
      }
  
      const abortController = new AbortController()
      setAbortController(abortController)
  
      const mapper = async (file:_File) => {
        try {
          setFileStates(next => ( {...next, [file.path]: {status: 'uploading', percent: 0}}))
          await uploadFile(config, repo, reference, currentPath, file, progress => {
            setFileStates(next => ( {...next, [file.path]: {status: 'uploading', percent: progress}}))
          })
        } catch (error: any | null) {
          setFileStates(next => ( {...next, [file.path]: {status: 'error'}}))
          setUploadState({ ...initialState, error });
          throw error;
        }
        setFileStates(next => ( {...next, [file.path]: {status: 'done'}}))
      }
  
      setUploadState({...initialState,  inProgress: true });
      try {
        await pMap(files, mapper, {
          concurrency: MAX_PARALLEL_UPLOADS,
          signal: abortController.signal
        });
        onDone();
        hide();
      } catch (error: any) {
        if (error instanceof DOMException) {
          // abort!
          onDone();
          hide();
        } else {
          setUploadState({ ...initialState, error });
        }
      }
  
  
    };
  
    const changeCurrentPath = useCallback((e) => {
      setCurrentPath(e.target.value)
    }, [setCurrentPath])
  
    const onRemoveCandidate = useCallback((file: _File) => {
      return () => setFiles(current => current.filter(f => f !== file))
    }, [setFiles])
  
    return (
      <>
        <Modal size="xl" show={show} onHide={hide}>
          <Modal.Header closeButton>
            <Modal.Title>Upload Object</Modal.Title>
          </Modal.Header>
          <Modal.Body>
            <Form
              onSubmit={(e) => {
                if (uploadState.inProgress) return;
                e.preventDefault();
                upload();
              }}
            >
              {config?.warnings && (
                <Form.Group controlId="warnings" className="mb-3">
                  <Warnings warnings={config.warnings} />
                </Form.Group>
              )}
  
              <Form.Group controlId="path" className="mb-3">
                <Form.Text>Path</Form.Text>
                <Form.Control disabled={uploadState.inProgress} defaultValue={currentPath} onChange={changeCurrentPath}/>
              </Form.Group>
  
              <Form.Group controlId="content" className="mb-3">
                <div {...getRootProps({className: 'dropzone'})}>
                    <input {...getInputProps()} />
                    <div className={isDragAccept ? "file-drop-zone file-drop-zone-focus" : "file-drop-zone"}>
                      Drag &apos;n&apos; drop files or folders here (or click to select)
                    </div>
                </div>
                <aside className="mt-3">
                  {(files && files.length > 0) &&
                    <h5>{files.length} File{files.length > 1 ? "s":""} to upload ({humanSize(files.reduce((a,f) => a + f.size ,0))})</h5>
                  }
                  {files && files.map(file =>
                      <UploadCandidate
                        key={file.path}
                        repo={repo}
                        reference={reference}
                        file={file}
                        path={currentPath}
                        state={fileStates[file.path]}
                        onRemove={!uploadState.inProgress ? onRemoveCandidate(file) : null}
                      />
                  )}
                </aside>
              </Form.Group>
            </Form>
          {(uploadState.error) ? (<AlertError error={uploadState.error}/>) : (<></>)}
        </Modal.Body>
      <Modal.Footer>
          <Button variant="secondary" onClick={hide}>
              Cancel
          </Button>
          <Button variant="success" disabled={uploadState.inProgress || files.length < 1} onClick={() => {
              if (uploadState.inProgress) return;
              upload()
          }}>
              {(uploadState.inProgress) ? 'Uploading...' : 'Upload'}
          </Button>
      </Modal.Footer>
    </Modal>
  
      <Button
        variant={!config.import_support ? "success" : "light"}
        onClick={onClick}
        >
        <UploadIcon /> Upload Object
      </Button>
    </>
    );
  };
  